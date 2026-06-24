import {
  InteractionRequiredAuthError,
  LogLevel,
  PublicClientApplication,
  type AccountInfo,
  type Configuration,
} from "@azure/msal-node";
import type { MsTodoBackendConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { logger as defaultLogger } from "../../logger.js";
import { createEncryptedTokenCachePlugin } from "./tokenCache.js";

export class MsAuth {
  private readonly pca: PublicClientApplication;
  private cachedAccount: AccountInfo | undefined;

  constructor(
    private readonly config: MsTodoBackendConfig,
    tokenKey: Buffer,
    private readonly log: Logger = defaultLogger,
  ) {
    const msalConfig: Configuration = {
      auth: {
        clientId: config.clientId,
        authority: config.authority,
      },
      cache: {
        cachePlugin: createEncryptedTokenCachePlugin(
          config.tokenCachePath,
          tokenKey,
          log,
        ),
      },
      system: {
        loggerOptions: {
          loggerCallback: (level, message) => {
            if (level <= LogLevel.Warning) this.log.debug("MSAL message", { message });
          },
          logLevel: LogLevel.Warning,
          piiLoggingEnabled: false,
        },
      },
    };

    this.pca = new PublicClientApplication(msalConfig);
  }

  async getAccessToken(): Promise<string> {
    const scopes = this.config.scopes;
    const account = await this.getCachedAccount();

    if (account) {
      try {
        const result = await this.pca.acquireTokenSilent({ account, scopes });
        if (result?.accessToken) return result.accessToken;
      } catch (err) {
        if (!(err instanceof InteractionRequiredAuthError)) {
          throw new Error("Silent Microsoft token acquisition failed", { cause: err });
        }
        this.log.info("Microsoft token requires interactive refresh");
      }
    }

    try {
      const result = await this.pca.acquireTokenByDeviceCode({
        scopes,
        deviceCodeCallback: (response) => {
          this.log.info("Microsoft device-code authentication required", {
            verificationUri: response.verificationUri,
            userCode: response.userCode,
            expiresIn: response.expiresIn,
          });
        },
      });
      if (!result?.accessToken) {
        throw new Error("Device-code flow completed without an access token");
      }
      this.cachedAccount = result.account ?? undefined;
      return result.accessToken;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("AADSTS90133") || message.includes("90133")) {
        // Some /common personal-account cases reject device code; the operational
        // fallback is auth-code + PKCE with a localhost redirect URI.
        throw new Error(
          "Microsoft device-code auth failed with AADSTS90133; use auth-code + PKCE fallback for this account.",
          { cause: err },
        );
      }
      throw new Error("Microsoft device-code authentication failed", { cause: err });
    }
  }

  private async getCachedAccount(): Promise<AccountInfo | undefined> {
    if (this.cachedAccount) return this.cachedAccount;
    const accounts = await this.pca.getTokenCache().getAllAccounts();
    const account = accounts[0];
    if (account) this.cachedAccount = account;
    return account;
  }
}
