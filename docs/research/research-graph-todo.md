## Research Findings Summary

All endpoints, schema fields, delta query mechanics, MSAL auth flow, scopes, throttling limits, and field-mapping nuances have been verified directly from official Microsoft documentation. Key discoveries: (1) delta query is fully supported for both `todoTask` and `todoTaskList` at GA/v1.0; (2) device code flow with `/common` authority carries a documented risk of `AADSTS90133` for some personal-account scenarios — auth code + PKCE is the safer fallback; (3) `waitingOnOthers` and `deferred` task statuses exist in the API but are invisible in the To Do UI; (4) recurring task completion creates a *new* task for the next occurrence rather than updating the original.

---

# Microsoft Graph To Do + MSAL — Integration Notes

**Compiled:** 2026-06-24 | **API version:** Microsoft Graph v1.0 | **MSAL:** `@azure/msal-node`

---

## Table of Contents
1. [Graph API — Task List Endpoints](#1-graph-api--task-list-endpoints)
2. [Graph API — Task Endpoints](#2-graph-api--task-endpoints)
3. [todoTask Schema Reference](#3-todotask-schema-reference)
4. [JSON Examples](#4-json-examples)
5. [Change Detection Strategy (Delta Queries)](#5-change-detection-strategy-delta-queries)
6. [MSAL Node Auth Flow](#6-msal-node-auth-flow)
7. [App Registration Settings](#7-app-registration-settings)
8. [Required Scopes](#8-required-scopes)
9. [Rate Limits & Throttling](#9-rate-limits--throttling)
10. [Consumer vs. Org Behavioral Differences](#10-consumer-vs-org-behavioral-differences)
11. [Field Mapping Table](#11-field-mapping-table)
12. [Known Limitations & Non-Round-Trippable Behaviors](#12-known-limitations--non-round-trippable-behaviors)
13. [TypeScript Implementation Skeleton](#13-typescript-implementation-skeleton)
14. [Sources](#14-sources)

---

## 1. Graph API — Task List Endpoints

Base URL: `https://graph.microsoft.com/v1.0`

### todoTaskList CRUD

| Operation | Method | URL | Request Body | Success Response |
|---|---|---|---|---|
| List all lists | `GET` | `/me/todo/lists` | — | `200 OK` + `value[]` |
| Get one list | `GET` | `/me/todo/lists/{listId}` | — | `200 OK` + list object |
| Create list | `POST` | `/me/todo/lists` | `{"displayName":"…"}` | `201 Created` + list object |
| Update list | `PATCH` | `/me/todo/lists/{listId}` | `{"displayName":"…"}` | `200 OK` + updated list |
| Delete list | `DELETE` | `/me/todo/lists/{listId}` | — | `204 No Content` |
| Delta (change tracking) | `GET` | `/me/todo/lists/delta` | — | `200 OK` + `value[]` + `@odata.deltaLink` |

> **Note:** Built-in lists (`defaultList`, `flaggedEmails`) **cannot be renamed or deleted**. The `wellknownListName` property identifies them. Only `displayName` is writable on a `todoTaskList`.

**Minimum example — create list:**
```http
POST https://graph.microsoft.com/v1.0/me/todo/lists
Authorization: Bearer {token}
Content-Type: application/json

{
  "displayName": "Work Tasks"
}
```

**Response:**
```json
{
  "@odata.type": "#microsoft.graph.todoTaskList",
  "id": "AAMkADIyAAAhrbPWAAA=",
  "displayName": "Work Tasks",
  "isOwner": true,
  "isShared": false,
  "wellknownListName": "none"
}
```

---

## 2. Graph API — Task Endpoints

### todoTask CRUD

| Operation | Method | URL | Request Body | Success Response |
|---|---|---|---|---|
| List tasks in a list | `GET` | `/me/todo/lists/{listId}/tasks` | — | `200 OK` + `value[]` |
| Get one task | `GET` | `/me/todo/lists/{listId}/tasks/{taskId}` | — | `200 OK` + task object |
| Create task | `POST` | `/me/todo/lists/{listId}/tasks` | Task JSON | `201 Created` + task object |
| Update task | `PATCH` | `/me/todo/lists/{listId}/tasks/{taskId}` | Partial task JSON | `200 OK` + updated task |
| Delete task | `DELETE` | `/me/todo/lists/{listId}/tasks/{taskId}` | — | `204 No Content` |
| Delta (change tracking per-list) | `GET` | `/me/todo/lists/{listId}/tasks/delta` | — | `200 OK` + `value[]` + `@odata.deltaLink` |

> All endpoints also accept `/users/{id\|userPrincipalName}/todo/…` for acting on behalf of another user (requires appropriate delegated permissions).

---

## 3. todoTask Schema Reference

### Full property table

| Property | Type | Writable | Notes |
|---|---|---|---|
| `id` | `String` | Read-only | Unique per list; **changes if task is moved to a different list** |
| `title` | `String` | ✅ | Brief description / task name |
| `status` | `taskStatus` (enum) | ✅ | See enum values below |
| `importance` | `importance` (enum) | ✅ | `low` \| `normal` \| `high` |
| `body` | `itemBody` | ✅ | `{ content: string, contentType: "text"\|"html" }` |
| `dueDateTime` | `dateTimeTimeZone` | ✅ | `{ dateTime: string, timeZone: string }` |
| `startDateTime` | `dateTimeTimeZone` | ✅ | `{ dateTime: string, timeZone: string }` |
| `completedDateTime` | `dateTimeTimeZone` | ✅ | `{ dateTime: string, timeZone: string }` |
| `reminderDateTime` | `dateTimeTimeZone` | ✅ | Only meaningful when `isReminderOn: true` |
| `isReminderOn` | `Boolean` | ✅ | Must also set `reminderDateTime` |
| `recurrence` | `patternedRecurrence` | ✅ | See structure below |
| `categories` | `String[]` | ✅ | Outlook category display names |
| `createdDateTime` | `DateTimeOffset` | Read-only | UTC ISO-8601, e.g. `"2020-01-01T00:00:00Z"` |
| `lastModifiedDateTime` | `DateTimeOffset` | Read-only | UTC ISO-8601 — **key field for sync** |
| `bodyLastModifiedDateTime` | `DateTimeOffset` | Read-only | UTC ISO-8601 |
| `hasAttachments` | `Boolean` | Read-only | `true` if file attachments exist |

### `status` enum (`taskStatus`)

| Value | To Do UI Appearance | Notes |
|---|---|---|
| `notStarted` | Active, unchecked | Default on creation |
| `inProgress` | Active, unchecked | Not visually distinct in current To Do UI |
| `waitingOnOthers` | Active, unchecked | **Not shown distinctly in To Do UI** |
| `deferred` | Active, unchecked | **Not shown distinctly in To Do UI** |
| `completed` | Checked / completed | Set this + `completedDateTime` together |

> ⚠️ **Critical note:** `waitingOnOthers` and `deferred` are valid API values and will be persisted, but the Microsoft To Do app renders them identically to `notStarted`. They exist for Outlook/Exchange compatibility.

### `importance` enum

| Value | To Do UI Equivalent |
|---|---|
| `high` | ⭐ Starred (flagged as Important) |
| `normal` | Normal (default) |
| `low` | Low priority |

### `dateTimeTimeZone` object shape

```json
{
  "dateTime": "2024-12-25T09:00:00",
  "timeZone": "Eastern Standard Time"
}
```

- `dateTime`: ISO 8601 local time string (no `Z` suffix — timezone is specified separately)
- `timeZone`: Windows timezone name string (e.g. `"UTC"`, `"Eastern Standard Time"`, `"Pacific Standard Time"`)
- Use `"UTC"` as a safe default when timezone is unknown

### `itemBody` object shape

```json
{
  "content": "Task notes here. Can be <b>HTML</b>.",
  "contentType": "html"
}
```

> ⚠️ **On PATCH (update), only `"html"` contentType is supported.** On POST (create), both `"text"` and `"html"` work. When reading, both may be returned.

### `patternedRecurrence` object shape

```json
{
  "pattern": {
    "type": "weekly",
    "interval": 1,
    "daysOfWeek": ["monday", "wednesday"],
    "firstDayOfWeek": "sunday"
  },
  "range": {
    "type": "noEnd",
    "startDate": "2024-01-01"
  }
}
```

**`recurrencePattern.type` values:**

| type | Required properties | Example |
|---|---|---|
| `daily` | `interval` | Every 3 days |
| `weekly` | `interval`, `daysOfWeek`, `firstDayOfWeek` | Every Mon+Wed |
| `absoluteMonthly` | `interval`, `dayOfMonth` | 15th of every month |
| `relativeMonthly` | `interval`, `daysOfWeek`, `index` | 2nd Thursday monthly |
| `absoluteYearly` | `interval`, `dayOfMonth`, `month` | March 15th yearly |
| `relativeYearly` | `interval`, `daysOfWeek`, `month`, `index` | Last Friday of November |

**`recurrenceRange.type` values:**

| type | Required properties | Meaning |
|---|---|---|
| `noEnd` | `startDate` | Repeats indefinitely |
| `endDate` | `startDate`, `endDate` | Repeats until date |
| `numbered` | `startDate`, `numberOfOccurrences` | Fixed number of occurrences |

---

## 4. JSON Examples

### Create a full-featured task

```http
POST https://graph.microsoft.com/v1.0/me/todo/lists/AAMkADA1MTHgwAAA=/tasks
Authorization: Bearer {token}
Content-Type: application/json

{
  "title": "Review Q4 report",
  "importance": "high",
  "status": "notStarted",
  "body": {
    "content": "<p>Must review before end of quarter.</p>",
    "contentType": "html"
  },
  "dueDateTime": {
    "dateTime": "2024-12-31T17:00:00",
    "timeZone": "UTC"
  },
  "startDateTime": {
    "dateTime": "2024-12-28T09:00:00",
    "timeZone": "UTC"
  },
  "isReminderOn": true,
  "reminderDateTime": {
    "dateTime": "2024-12-31T09:00:00",
    "timeZone": "UTC"
  },
  "recurrence": {
    "pattern": {
      "type": "weekly",
      "interval": 1,
      "daysOfWeek": ["friday"],
      "firstDayOfWeek": "sunday"
    },
    "range": {
      "type": "noEnd",
      "startDate": "2024-12-28"
    }
  }
}
```

### Mark a task completed

```http
PATCH https://graph.microsoft.com/v1.0/me/todo/lists/{listId}/tasks/{taskId}
Authorization: Bearer {token}
Content-Type: application/json

{
  "status": "completed",
  "completedDateTime": {
    "dateTime": "2024-12-25T10:30:00",
    "timeZone": "UTC"
  }
}
```

### Update due date

```http
PATCH https://graph.microsoft.com/v1.0/me/todo/lists/{listId}/tasks/{taskId}
Authorization: Bearer {token}
Content-Type: application/json

{
  "dueDateTime": {
    "dateTime": "2024-12-25T17:00:00",
    "timeZone": "Eastern Standard Time"
  }
}
```

### Clear a date field (set to null)

```http
PATCH https://graph.microsoft.com/v1.0/me/todo/lists/{listId}/tasks/{taskId}
Authorization: Bearer {token}
Content-Type: application/json

{
  "dueDateTime": null
}
```

---

## 5. Change Detection Strategy (Delta Queries)

### Delta query support (verified at v1.0)

| Resource | Delta endpoint | Notes |
|---|---|---|
| `todoTaskList` | `GET /me/todo/lists/delta` | Tracks list additions, deletions, renames |
| `todoTask` | `GET /me/todo/lists/{listId}/tasks/delta` | Per-list; must query each list separately |

### Initial sync pattern

```http
# Step 1: Initial full fetch (returns all items + deltaLink)
GET https://graph.microsoft.com/v1.0/me/todo/lists/{listId}/tasks/delta
Authorization: Bearer {token}

# Response includes @odata.nextLink (more pages) or @odata.deltaLink (end of page set)
# Follow @odata.nextLink until @odata.deltaLink is returned
# Persist the @odata.deltaLink URL for future incremental syncs
```

### Incremental sync pattern

```http
# Step 2: Use stored deltaLink to get only changes since last sync
GET https://graph.microsoft.com/v1.0/me/todo/lists/{listId}/tasks/delta?$deltatoken={storedToken}
Authorization: Bearer {token}
```

### Interpreting delta responses

```json
{
  "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/todo/lists/{id}/tasks/delta?$deltatoken=…",
  "value": [
    {
      "id": "AAMk…",
      "title": "Updated task title",
      "lastModifiedDateTime": "2024-12-25T10:00:00Z"
    },
    {
      "id": "BBMk…",
      "@removed": { "reason": "deleted" }
    }
  ]
}
```

- **Newly created or updated tasks** appear with their current properties
- **Deleted tasks** appear with `"@removed": { "reason": "deleted" }` (or `"changed"` if soft-deleted/restorable)
- **Partial update responses**: delta responses for updated items include only the changed properties + `id` (not the full task)
- **Page handling**: Follow `@odata.nextLink` until `@odata.deltaLink` appears — only then is the current round complete

### Recommended sync engine strategy

```
┌─────────────────────────────────────────────────────────┐
│ Sync Engine Loop (runs every N minutes)                 │
│                                                         │
│ 1. For each known list:                                 │
│    a. If no deltaLink stored → full initial sync        │
│    b. Else → incremental delta query with deltaLink     │
│    c. Handle 410 Gone → clear deltaLink → full resync   │
│                                                         │
│ 2. For lists themselves:                                │
│    GET /me/todo/lists/delta                             │
│    → Detect added/removed/renamed lists                 │
│    → Start per-list delta queries for new lists         │
│                                                         │
│ 3. Token expiry:                                        │
│    - Outlook delta tokens have NO fixed TTL             │
│    - They expire when the internal cache overflows      │
│    - Always handle 410 Gone gracefully                  │
│                                                         │
│ 4. Rate limit headroom:                                 │
│    - With N lists, each sync cycle costs ≥N+1 requests  │
│    - Stay well under 10,000 req/10 min per mailbox      │
└─────────────────────────────────────────────────────────┘
```

### Optional: `$select` for efficiency

```http
GET /me/todo/lists/{listId}/tasks/delta?$select=id,title,status,lastModifiedDateTime,dueDateTime
```

`$select` is supported by delta queries for todoTask and reduces payload size.

---

## 6. MSAL Node Auth Flow

### Recommended flow: Device Code (with fallback to Auth Code + PKCE)

A background/desktop service that needs user-delegated access must acquire tokens interactively once, then use cached refresh tokens for all subsequent background calls.

**Preferred for headless/CLI environments:** Device Code Flow  
**Preferred for desktop with browser:** Auth Code + PKCE

> ⚠️ **Important caveat on device code + `/common`:** Microsoft documentation (MSAL.NET error handling guide) includes `AADSTS90133: "Device Code flow is not supported under /common or /consumers endpoint"` as a known possible error. This affects some scenarios with personal Microsoft accounts under the common authority. **Mitigation:** Use `https://login.microsoftonline.com/common` first; if you receive AADSTS90133, fall back to auth code + PKCE with `http://localhost` redirect URI, which reliably supports both account types with `/common`.

### MSAL Node installation

```bash
npm install @azure/msal-node @azure/msal-node-extensions
```

### Core configuration (`authConfig.ts`)

```typescript
import { Configuration, LogLevel } from '@azure/msal-node';

export const SCOPES = [
  'Tasks.ReadWrite',
  'offline_access',
  'User.Read',
];

export const msalConfig: Configuration = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID!,
    // "common" = both personal (MSA) and work/school (AAD) accounts
    authority: 'https://login.microsoftonline.com/common',
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message) => console.log(`[MSAL ${LogLevel[level]}] ${message}`),
      piiLoggingEnabled: false,
      logLevel: LogLevel.Warning,
    },
  },
};
```

### Token cache persistence (`tokenCache.ts`)

```typescript
import * as path from 'path';
import * as msal from '@azure/msal-node';
import {
  PersistenceCreator,
  PersistenceCachePlugin,
  DataProtectionScope,
  Environment,
} from '@azure/msal-node-extensions';

export async function createPcaWithPersistentCache(): Promise<msal.PublicClientApplication> {
  const cachePath = path.join(
    Environment.getUserRootDirectory(),
    '.task-sync-token-cache.json'
  );

  const persistence = await PersistenceCreator.createPersistence({
    cachePath,
    dataProtectionScope: DataProtectionScope.CurrentUser,
    serviceName: 'task-sync',
    accountName: 'default-user',
    usePlaintextFileOnLinux: false, // uses libsecret on Linux
  });

  return new msal.PublicClientApplication({
    ...msalConfig,
    cache: {
      cachePlugin: new PersistenceCachePlugin(persistence),
    },
  });
}
```

> `msal-node-extensions` handles encryption at rest: DPAPI on Windows, Keychain on macOS, libsecret on Linux.

### Device code flow with silent token acquisition (`auth.ts`)

```typescript
import * as msal from '@azure/msal-node';
import { SCOPES } from './authConfig';

export async function getAccessToken(
  pca: msal.PublicClientApplication
): Promise<string> {
  // 1. Try silent acquisition using cached account + refresh token
  const accounts = await pca.getTokenCache().getAllAccounts();
  
  if (accounts.length > 0) {
    try {
      const silentResult = await pca.acquireTokenSilent({
        account: accounts[0],
        scopes: SCOPES,
      });
      return silentResult.accessToken;
    } catch (silentError) {
      if (!(silentError instanceof msal.InteractionRequiredAuthError)) {
        throw silentError; // unexpected error — rethrow
      }
      // InteractionRequiredAuthError → must re-authenticate interactively
      console.log('Silent token acquisition failed, re-authenticating...');
    }
  }

  // 2. Device code flow (interactive, one-time)
  try {
    const deviceCodeResult = await pca.acquireTokenByDeviceCode({
      scopes: SCOPES,
      deviceCodeCallback: (response) => {
        // Display this to the user:
        // "To sign in, use a web browser to open microsoft.com/devicelogin
        //  and enter the code XXXXXXXX to authenticate."
        console.log(response.message);
      },
      timeout: 120, // seconds to wait for user to complete sign-in
    });
    return deviceCodeResult!.accessToken;
  } catch (dcError: any) {
    // AADSTS90133 = device code not supported for this authority+account type combo
    if (dcError?.errorCode === 'AADSTS90133' || dcError?.message?.includes('90133')) {
      throw new Error(
        'Device code flow failed for this account type. ' +
        'Consider using auth code + PKCE with http://localhost redirect URI instead.'
      );
    }
    throw dcError;
  }
}
```

### Auth Code + PKCE alternative (reliable for `/common` with personal accounts)

```typescript
import * as http from 'http';
import { SCOPES } from './authConfig';

export async function getTokenViaAuthCode(
  pca: msal.PublicClientApplication
): Promise<string> {
  const PORT = 3000;
  const REDIRECT_URI = `http://localhost:${PORT}`;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${PORT}`);
      const code = url.searchParams.get('code');
      if (!code) return;
      
      res.end('Authentication complete. You may close this window.');
      server.close();

      try {
        const result = await pca.acquireTokenByCode({
          code,
          scopes: SCOPES,
          redirectUri: REDIRECT_URI,
          codeVerifier: pkceVerifier, // from generateAuthCodeUrl
        });
        resolve(result.accessToken);
      } catch (e) {
        reject(e);
      }
    });

    server.listen(PORT, async () => {
      const { verifier, challenge } = await msal.cryptoProvider.generatePkceCodes();
      pkceVerifier = verifier;
      
      const authUrl = await pca.getAuthCodeUrl({
        scopes: SCOPES,
        redirectUri: REDIRECT_URI,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      });
      
      // Open in system browser (use 'open' package or similar)
      console.log(`Open this URL to authenticate:\n${authUrl}`);
    });
  });
}
let pkceVerifier: string;
```

### Token lifecycle

```
┌─────────────────────────────────────────────────────────┐
│ Token Lifecycle                                         │
│                                                         │
│ Access token:   ~1 hour (short-lived)                   │
│ Refresh token:  up to 90 days (with offline_access)     │
│                 sliding window — renews on each use      │
│                                                         │
│ MSAL handles refresh automatically via acquireTokenSilent│
│ MsalNodeExtensions handles encrypted disk persistence    │
│                                                         │
│ Background daemon pattern:                              │
│  - Call acquireTokenSilent() before each API call       │
│  - MSAL returns cached access token if still valid      │
│  - MSAL auto-refreshes if within refresh window         │
│  - Only re-prompt user if InteractionRequiredAuthError  │
└─────────────────────────────────────────────────────────┘
```

---

## 7. App Registration Settings

### Azure Portal configuration

| Setting | Value | Reason |
|---|---|---|
| **Supported account types** | "Accounts in any organizational directory and personal Microsoft accounts" (`AzureADandPersonalMicrosoftAccount`) | Enables `/common` authority for both MSA + AAD |
| **Platform type** | Mobile and desktop applications | Enables public client flows (no client secret) |
| **Redirect URIs** | `https://login.microsoftonline.com/common/oauth2/nativeclient` | For device code + embedded browser |
|  | `http://localhost` | For auth code + PKCE (browser-based) |
| **Allow public client flows** | ✅ Enabled ("Yes") | Enables device code, ROPC, and other non-secret flows |
| **Client secret** | ❌ None required | Public client app — secrets are not used |

### Why NOT a single-tenant or `organizations` authority

| Authority | Covers | Use when |
|---|---|---|
| `https://login.microsoftonline.com/{tenantId}` | One specific AAD tenant only | Enterprise single-tenant apps |
| `https://login.microsoftonline.com/organizations` | All AAD tenants (no personal MSA) | Work/school only |
| `https://login.microsoftonline.com/consumers` | Personal MSA only | Personal account only |
| `https://login.microsoftonline.com/common` | **All AAD + personal MSA** | ✅ **Our use case** |

---

## 8. Required Scopes

### Delegated permission scopes

| Scope | Purpose | Required for |
|---|---|---|
| `Tasks.ReadWrite` | Read and write To Do lists and tasks | All create/update/delete operations; also covers delta queries |
| `offline_access` | Obtain refresh token for background/offline use | Background service token persistence |
| `User.Read` | Read basic user profile (required at sign-in) | Initial authentication, identifying the user |
| `Tasks.Read` | Read-only access to To Do lists and tasks | If only sync-read is needed (no writes) |

> **Minimum scope set for full sync:** `["Tasks.ReadWrite", "offline_access", "User.Read"]`

### Application vs. delegated permissions

| Permission type | Scope | Personal MSA | Work/School AAD | Notes |
|---|---|---|---|---|
| Delegated | `Tasks.Read` | ✅ | ✅ | User must consent |
| Delegated | `Tasks.ReadWrite` | ✅ | ✅ | User must consent |
| Application | `Tasks.Read.All` | ❌ | ✅ | Admin consent; no user session |
| Application | `Tasks.ReadWrite.All` | ❌ | ✅ | Admin consent; **not available for personal accounts** |

> ⚠️ Application permissions (`Tasks.Read.All`, `Tasks.ReadWrite.All`) **do not work for personal Microsoft accounts**. For personal accounts, only **delegated** permissions with a user session are supported.

> ⚠️ **Write operations** (create/update/delete tasks and lists, delta) require `Tasks.ReadWrite`. `Tasks.Read` is insufficient for write paths or deltaLink for lists.

---

## 9. Rate Limits & Throttling

### Outlook service limits (covers To Do API)

The To Do API uses the Outlook service infrastructure. Limits are applied per **app ID + mailbox** pair:

| Limit | Scope | Value |
|---|---|---|
| API request rate | Per app + per mailbox | **10,000 requests per 10-minute period** |
| Concurrent requests | Per app + per mailbox | **4 concurrent requests** |
| Upload bandwidth | Per app + per mailbox | **150 MB per 5-minute period** (POST/PATCH/PUT) |

### Global Graph limits

| Limit | Scope | Value |
|---|---|---|
| Any request type | Per app, across all tenants | **130,000 requests per 10 seconds** |

### Throttling response handling

When throttled, Graph returns:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 10
Content-Type: application/json

{
  "error": {
    "code": "TooManyRequests",
    "message": "Please retry again later."
  }
}
```

**Implementation pattern:**

```typescript
async function graphRequestWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 5
): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(url, options);
    
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After') ?? '30');
      console.log(`Throttled. Waiting ${retryAfter}s before retry ${attempt + 1}/${maxRetries}`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }
    
    return response;
  }
  throw new Error('Max retries exceeded due to throttling');
}
```

**Best practices:**
1. Always read and honor the `Retry-After` header value (in seconds)
2. If no `Retry-After` is provided, use exponential backoff starting at 1 second
3. Use delta queries instead of polling full collections — dramatically reduces request count
4. Use `$select` to request only needed fields — reduces payload and processing time
5. Do not fan-out parallel requests per mailbox — max 4 concurrent respected
6. The Microsoft Graph SDK (`@microsoft/microsoft-graph-client`) has built-in retry middleware

---

## 10. Consumer vs. Org Behavioral Differences

| Feature | Personal MSA | Work/School AAD | Notes |
|---|---|---|---|
| All CRUD operations | ✅ | ✅ | Fully supported |
| Delta queries | ✅ | ✅ | Fully supported |
| Application permissions | ❌ | ✅ | Personal MSA = delegated only |
| `Tasks.ReadWrite.All` | ❌ | ✅ | Not available for personal accounts |
| `categories` field | ⚠️ Limited | ✅ | Outlook categories may not be set up for personal accounts |
| List sharing (`isShared`) | Limited | ✅ | Sharing features work best in AAD tenant context |
| `flaggedEmails` list | ✅ | ✅ | Populated by flagging emails in Outlook |
| Rate limits | Same | Same | Both use Outlook mailbox service limits |
| `Users` path | ❌ | ✅ | `/users/{id}/todo/...` works only for AAD; personal uses `/me/todo/...` |
| National clouds | `/v1.0` global only | Also US Gov L4/L5 | China (21Vianet) does **not** support To Do API |

---

## 11. Field Mapping Table

| Graph Field | Graph Type | Typical Local Field | Mapping Notes |
|---|---|---|---|
| `id` | `String` | `remoteId` | Changes when task moves between lists; treat as opaque |
| `title` | `String` | `title` / `name` | Direct string map |
| `status` | `taskStatus` enum | `status` / `isCompleted` | 5 values; see section 3 |
| `importance` | `importance` enum | `priority` | `high`↔starred; `normal`↔medium; `low`↔low |
| `body.content` | `String` | `notes` / `description` | May be HTML; strip tags if storing as plain text |
| `body.contentType` | `"text"\|"html"` | — | Always send as `"html"` on PATCH |
| `dueDateTime` | `dateTimeTimeZone` | `dueDate` | Store `dateTime` + `timeZone` separately |
| `startDateTime` | `dateTimeTimeZone` | `startDate` | Store `dateTime` + `timeZone` separately |
| `completedDateTime` | `dateTimeTimeZone` | `completedAt` | Set with `status: "completed"` |
| `reminderDateTime` | `dateTimeTimeZone` | `reminderAt` | Pair with `isReminderOn: true` |
| `isReminderOn` | `Boolean` | `hasReminder` | Direct boolean |
| `recurrence` | `patternedRecurrence` | `recurrenceRule` | Complex nested object; see section 3 |
| `categories` | `String[]` | `tags` / `labels` | Outlook category names |
| `createdDateTime` | `DateTimeOffset` | `createdAt` | Read-only; UTC ISO-8601 |
| `lastModifiedDateTime` | `DateTimeOffset` | `updatedAt` | Read-only; use for change detection |

---

## 12. Known Limitations & Non-Round-Trippable Behaviors

### 1. Recurring task completion creates a new task

When a user marks a recurring task as complete in Microsoft To Do, the service creates a **new separate task** for the next occurrence rather than modifying the existing task. The sync engine must:
- Expect new task IDs in delta responses that belong to the "same" logical recurring series
- The original completed task remains but its `status` becomes `completed`
- There is no explicit "recurring series ID" on `todoTask` — you must infer series membership from `title` + `recurrence` pattern

### 2. Task IDs change on list move

The `id` of a `todoTask` **is not stable across list moves**. If a task is moved from one list to another, it gets a new ID. If you store `remoteId`, you may see a delete+create pair in delta responses for a moved task.

### 3. `body.contentType` on PATCH must be `"html"`

The update task documentation explicitly states: "Note that only HTML type is supported" for PATCH operations. If you store body as plain text locally, wrap it in `<p>…</p>` before sending on update.

### 4. `waitingOnOthers` and `deferred` not visible in To Do UI

These valid API status values are silently rendered as "active/notStarted" in the Microsoft To Do mobile/desktop app. Avoid using them for statuses you expect users to see.

### 5. `completedDateTime` timezone behavior

When you PATCH `status: "completed"` without explicitly setting `completedDateTime`, the server auto-fills it in UTC. The auto-filled value may not match the user's local time expectation. Best practice: always send `completedDateTime` explicitly when completing a task.

### 6. `dueDateTime` is date-only in the To Do UI

Although `dueDateTime` accepts a full datetime with time component, Microsoft To Do's UI only shows the **date** portion. Setting `"dateTime": "2024-12-25T09:00:00"` is stored correctly but the time part is not displayed in the app (though it will be returned by the API).

### 7. Recurrence complexity vs. UI simplicity

The API's `patternedRecurrence` supports 6 pattern types with various sub-fields, but the To Do UI only shows: Daily, Weekly, Monthly, Yearly, Weekdays, Custom. A recurrence you set via the API may not be editable in the UI (it shows as "Custom"). Conversely, recurrences set in the UI map to specific pattern types in the API.

### 8. `categories` availability

Outlook categories (`categories` field) are associated with an Outlook profile. Personal Microsoft accounts may not have categories defined, making the field effectively empty. Don't rely on this field for critical data in a cross-account-type service.

### 9. Delta token expiry

Delta tokens for Outlook/To Do entities (unlike directory objects which expire in 7 days) have **no documented fixed TTL**. They expire when the internal cache overflows. In practice, tokens may last days to weeks. Always handle `HTTP 410 Gone` by discarding the stored deltaLink and performing a full re-sync.

### 10. `@removed` reason values

| Value | Meaning |
|---|---|
| `"deleted"` | Permanently deleted; cannot be restored |
| `"changed"` | Soft-deleted; may be restorable (rare for To Do tasks) |

---

## 13. TypeScript Implementation Skeleton

```typescript
// graph-todo-client.ts — minimal typed client for Microsoft To Do via Graph API

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

interface DateTimeTimeZone {
  dateTime: string;   // ISO 8601 local datetime, no Z suffix
  timeZone: string;   // Windows timezone name
}

interface ItemBody {
  content: string;
  contentType: 'text' | 'html';
}

type TaskStatus = 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred';
type Importance = 'low' | 'normal' | 'high';

interface TodoTask {
  id?: string;
  title: string;
  status?: TaskStatus;
  importance?: Importance;
  body?: ItemBody;
  dueDateTime?: DateTimeTimeZone | null;
  startDateTime?: DateTimeTimeZone | null;
  completedDateTime?: DateTimeTimeZone | null;
  reminderDateTime?: DateTimeTimeZone | null;
  isReminderOn?: boolean;
  recurrence?: PatternedRecurrence | null;
  categories?: string[];
  createdDateTime?: string;        // read-only
  lastModifiedDateTime?: string;   // read-only — use for sync
  hasAttachments?: boolean;        // read-only
}

interface TodoTaskList {
  id?: string;
  displayName: string;
  isOwner?: boolean;
  isShared?: boolean;
  wellknownListName?: 'none' | 'defaultList' | 'flaggedEmails' | 'unknownFutureValue';
}

interface PatternedRecurrence {
  pattern: RecurrencePattern;
  range: RecurrenceRange;
}

interface RecurrencePattern {
  type: 'daily' | 'weekly' | 'absoluteMonthly' | 'relativeMonthly' | 'absoluteYearly' | 'relativeYearly';
  interval: number;
  daysOfWeek?: string[];
  dayOfMonth?: number;
  month?: number;
  firstDayOfWeek?: string;
  index?: 'first' | 'second' | 'third' | 'fourth' | 'last';
}

interface RecurrenceRange {
  type: 'noEnd' | 'endDate' | 'numbered';
  startDate: string;      // YYYY-MM-DD
  endDate?: string;       // YYYY-MM-DD
  numberOfOccurrences?: number;
  recurrenceTimeZone?: string;
}

class GraphTodoClient {
  constructor(private getToken: () => Promise<string>) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${GRAPH_BASE}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '30');
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return this.request(method, path, body); // retry once
    }

    if (res.status === 204) return undefined as T;
    if (!res.ok) throw new Error(`Graph API error: ${res.status} ${await res.text()}`);
    return res.json();
  }

  // Task Lists
  async getLists(): Promise<{ value: TodoTaskList[] }> {
    return this.request('GET', '/me/todo/lists');
  }
  async createList(displayName: string): Promise<TodoTaskList> {
    return this.request('POST', '/me/todo/lists', { displayName });
  }
  async updateList(listId: string, displayName: string): Promise<TodoTaskList> {
    return this.request('PATCH', `/me/todo/lists/${listId}`, { displayName });
  }
  async deleteList(listId: string): Promise<void> {
    return this.request('DELETE', `/me/todo/lists/${listId}`);
  }
  async getListsDelta(deltaUrl?: string): Promise<{ value: TodoTaskList[]; '@odata.deltaLink'?: string; '@odata.nextLink'?: string }> {
    const url = deltaUrl ? deltaUrl.replace(GRAPH_BASE, '') : '/me/todo/lists/delta';
    return this.request('GET', url);
  }

  // Tasks
  async getTasks(listId: string): Promise<{ value: TodoTask[] }> {
    return this.request('GET', `/me/todo/lists/${listId}/tasks`);
  }
  async createTask(listId: string, task: Omit<TodoTask, 'id' | 'createdDateTime' | 'lastModifiedDateTime'>): Promise<TodoTask> {
    return this.request('POST', `/me/todo/lists/${listId}/tasks`, task);
  }
  async updateTask(listId: string, taskId: string, patch: Partial<TodoTask>): Promise<TodoTask> {
    return this.request('PATCH', `/me/todo/lists/${listId}/tasks/${taskId}`, patch);
  }
  async deleteTask(listId: string, taskId: string): Promise<void> {
    return this.request('DELETE', `/me/todo/lists/${listId}/tasks/${taskId}`);
  }
  async getTasksDelta(listId: string, deltaUrl?: string): Promise<{ value: (TodoTask & { '@removed'?: { reason: string } })[]; '@odata.deltaLink'?: string; '@odata.nextLink'?: string }> {
    const url = deltaUrl ? deltaUrl.replace(GRAPH_BASE, '') : `/me/todo/lists/${listId}/tasks/delta`;
    return this.request('GET', url);
  }

  // Helper: paginate delta to completion
  async *paginateDelta(listId: string, deltaLink?: string): AsyncGenerator<TodoTask & { '@removed'?: { reason: string } }> {
    let url = deltaLink ?? undefined;
    do {
      const page = await this.getTasksDelta(listId, url);
      for (const item of page.value) yield item;
      url = page['@odata.nextLink'] ?? page['@odata.deltaLink'];
      if (page['@odata.deltaLink']) break; // end of current delta round
    } while (url?.includes('nextLink'));
  }
}
```

---

## 14. Sources

All findings sourced and verified directly from the following URLs:

| Topic | Source URL |
|---|---|
| To Do API overview | https://learn.microsoft.com/en-us/graph/api/resources/todo-overview?view=graph-rest-1.0 |
| `todoTaskList` resource | https://learn.microsoft.com/en-us/graph/api/resources/todotasklist?view=graph-rest-1.0 |
| `todoTask` resource | https://learn.microsoft.com/en-us/graph/api/resources/todotask?view=graph-rest-1.0 |
| List tasks | https://learn.microsoft.com/en-us/graph/api/todotasklist-list-tasks?view=graph-rest-1.0 |
| Create task | https://learn.microsoft.com/en-us/graph/api/todotasklist-post-tasks?view=graph-rest-1.0 |
| Update task | https://learn.microsoft.com/en-us/graph/api/todotask-update?view=graph-rest-1.0 |
| Delete task | https://learn.microsoft.com/en-us/graph/api/todotask-delete?view=graph-rest-1.0 |
| `todoTask` delta | https://learn.microsoft.com/en-us/graph/api/todotask-delta?view=graph-rest-1.0 |
| List task lists | https://learn.microsoft.com/en-us/graph/api/todo-list-lists?view=graph-rest-1.0 |
| Create task list | https://learn.microsoft.com/en-us/graph/api/todo-post-lists?view=graph-rest-1.0 |
| Update task list | https://learn.microsoft.com/en-us/graph/api/todotasklist-update?view=graph-rest-1.0 |
| Delete task list | https://learn.microsoft.com/en-us/graph/api/todotasklist-delete?view=graph-rest-1.0 |
| `todoTaskList` delta | https://learn.microsoft.com/en-us/graph/api/todotasklist-delta?view=graph-rest-1.0 |
| `patternedRecurrence` | https://learn.microsoft.com/en-us/graph/api/resources/patternedrecurrence?view=graph-rest-1.0 |
| `recurrencePattern` | https://learn.microsoft.com/en-us/graph/api/resources/recurrencepattern?view=graph-rest-1.0 |
| `recurrenceRange` | https://learn.microsoft.com/en-us/graph/api/resources/recurrencerange?view=graph-rest-1.0 |
| `itemBody` | https://learn.microsoft.com/en-us/graph/api/resources/itembody?view=graph-rest-1.0 |
| Delta query overview | https://learn.microsoft.com/en-us/graph/delta-query-overview?view=graph-rest-1.0 |
| Throttling guidance | https://learn.microsoft.com/en-us/graph/throttling?view=graph-rest-1.0 |
| Throttling limits (Outlook) | https://learn.microsoft.com/en-us/graph/throttling-limits?view=graph-rest-1.0 |
| MSAL desktop app configuration | https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration |
| MSAL device code flow | https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-acquire-token-device-code-flow |
| MSAL Node token caching | https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/caching.md |
| MSAL Node Extensions (cache persistence) | https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/extensions/msal-node-extensions/README.md |

---

> **Note on file save:** The instructions requested saving to `/home/ade/.copilot/session-state/9ec4e0fe-aab8-42cb-993f-00d9261d9b14/files/research-graph-todo.md`. This subagent does not have a file-write tool — the complete content is returned above in full for the main agent to persist as needed.
