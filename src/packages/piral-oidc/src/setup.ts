import { UserManager, Log } from 'oidc-client';
import { OidcConfig, OidcClient, OidcProfileWithCustomClaims } from './types';

/** Error message received when getting a user without an access token. */
export const notLoggedInMessage = 'Not logged in. Please call `login()` to retrieve a token.';
/** Error message received when silent renew fails in the background. */
export const silentRenewFailedMessage = 'Silent renew failed to retrieve access token';
/** Error message received when authentication fails unexpectedly. */
const invalidTokenMessage = 'Invalid token during authentication';

/**
 * Sets up a new client wrapping the oidc-client API.
 * @param config The configuration for the client.
 */
export function setupOidcClient(config: OidcConfig): OidcClient {
  const {
    clientId,
    clientSecret,
    identityProviderUri,
    redirectUri = `${location.origin}/auth`,
    postLogoutRedirectUri = location.origin,
    responseType,
    scopes,
    restrict = false,
    appUri,
  } = config;

  const userManager = new UserManager({
    authority: identityProviderUri,
    redirect_uri: redirectUri,
    silent_redirect_uri: redirectUri,
    popup_redirect_uri: redirectUri,
    post_logout_redirect_uri: postLogoutRedirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    response_type: responseType,
    scope: scopes?.join(' '),
  });

  if (process.env.NODE_ENV === 'development') {
    Log.logger = console;
    Log.level = Log.DEBUG;
  }

  if (window.location.pathname === new URL(userManager.settings.post_logout_redirect_uri).pathname) {
    if (window === window.top) {
      userManager.signoutRedirectCallback();
    } else {
      userManager.signoutPopupCallback();
    }
  }

  const retrieveToken = () => {
    return new Promise<string>((res, rej) => {
      userManager
        .getUser()
        .then((user) => {
          if (!user) {
            rej(notLoggedInMessage);
          } else if (user.access_token && user.expires_in > 60) {
            res(user.access_token);
          } else {
            return userManager.signinSilent().then((user) => {
              if (!user || !user.access_token) {
                throw new Error(silentRenewFailedMessage);
              }
              return res(user.access_token);
            });
          }
        })
        .catch((err) => rej(err));
    });
  };

  const retrieveProfile = () => {
    return new Promise<OidcProfileWithCustomClaims>((res, rej) => {
      userManager.getUser().then(
        (user) => {
          if (!user || user.expires_in <= 0) {
            rej(notLoggedInMessage);
          } else {
            res(user.profile as OidcProfileWithCustomClaims);
          }
        },
        (err) => rej(err),
      );
    });
  };

  const handleAuthentication = (): Promise<boolean> =>
    new Promise(async (resolve, reject) => {
      if (
        (window.location.pathname === new URL(userManager.settings.silent_redirect_uri).pathname ||
          window.location.pathname === new URL(userManager.settings.popup_redirect_uri).pathname) &&
        window !== window.top
      ) {
        /*
         * This is a silent redirect frame. The correct behavior is to notify the parent of the updated user,
         * and then to do nothing else. Encountering an error here means the background IFrame failed
         * to update the parent. This is usually due to a timeout from a network error.
         */
        try {
          await userManager.signinSilentCallback();
        } catch (e) {
          return reject(e);
        }
        return resolve(false);
      }

      if (window.location.pathname === new URL(userManager.settings.redirect_uri).pathname && window === window.top) {
        try {
          await userManager.signinCallback();
        } catch (e) {
          /*
           * Failing to handle a sign-in callback is non-recoverable. The user is expected to call `logout()`, after
           * logging this error to their internal error-handling service. Usually, this is due to a misconfigured auth server.
           */
          return reject(e);
        }

        if (appUri) {
          Log.debug(`Redirecting to ${appUri} due to appUri being configured.`);
          window.location.href = appUri;
          return resolve(false);
        }

        /* If appUri is not configured, we let the user decide what to do after getting a session. */
        return resolve(true);
      }

      /*
       * The current page is a normal flow, not a callback or signout. We should retrieve the current access_token,
       * or log the user in if there is no current session.
       * This branch of code should also tell the user to render the main application.
       */
      return retrieveToken()
        .then((token) => {
          if (token) {
            return resolve(true);
          } else {
            /* We should never get into this state, retireveToken() should reject if there is no token */
            return reject(new Error(invalidTokenMessage));
          }
        })
        .catch(async (reason) => {
          if (reason.message === notLoggedInMessage || reason === notLoggedInMessage) {
            /*
             * Expected Error during normal code flow:
             * This is the first time logging in since a logout (or ever), instead of asking the user
             * to call `login()`, just perform it ourself here.
             *
             * The resolve shouldn't matter, as `signinRedirect` will redirect the browser location
             * to the user's configured redirectUri.
             */
            await userManager.signinRedirect();
            return resolve(false);
          }

          /*
           * Getting here is a non-recoverable error. It is up to the user to determine what to do.
           * Usually this is a result of failing to reach the authentication server, or a misconfigured
           * authentication server, or a bad clock skew (commonly caused by docker in windows).
           */
          return reject(reason);
        });
    });

  return {
    login() {
      return userManager.signinRedirect();
    },
    logout() {
      return userManager.signoutRedirect();
    },
    handleAuthentication,
    extendHeaders(req) {
      if (!restrict) {
        req.setHeaders(
          retrieveToken().then(
            (token) => token && { Authorization: `Bearer ${token}` },
            () => undefined,
          ),
        );
      }
    },
    token: retrieveToken,
    account: retrieveProfile,
    events: userManager.events,
  };
}
