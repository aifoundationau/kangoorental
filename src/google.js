import { OAuth2Client } from 'google-auth-library';
import { config } from './config.js';
import { HttpError } from './security.js';

const client = new OAuth2Client();

/**
 * Verifies a Google Identity Services ID token (signature, audience, issuer, expiry) and returns the
 * Google account's stable id, verified email and name.
 */
export async function verifyGoogleCredential(credential) {
  if (!config.googleClientId) throw new HttpError(400, 'Google sign-in is not enabled.');
  if (typeof credential !== 'string' || credential.length < 100 || credential.length > 5000) {
    throw new HttpError(400, 'Google sign-in failed. Please try again.');
  }
  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: config.googleClientId });
    payload = ticket.getPayload();
  } catch {
    throw new HttpError(401, 'Google sign-in has expired or is invalid. Please sign in with Google again.');
  }
  if (!payload?.sub || !payload.email || payload.email_verified !== true) {
    throw new HttpError(401, 'Your Google account email is not verified.');
  }
  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name || '',
    picture: payload.picture || '',
  };
}

export function googleRedirectUri(req) {
  if (process.env.GOOGLE_OAUTH_REDIRECT_URI) return process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (config.onVercel && req?.get('host')) return `https://${req.get('host')}/api/auth/google/callback`;
  return `${config.baseUrl}/api/auth/google/callback`;
}

export function createGoogleAuthUrl({ redirectUri, state, codeChallenge }) {
  if (!config.googleOAuthEnabled) throw new HttpError(503, 'Google sign-in is not configured.');
  const oauth = new OAuth2Client(config.googleClientId, config.googleClientSecret, redirectUri);
  return oauth.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
}

export async function exchangeGoogleCode({ code, redirectUri, codeVerifier }) {
  if (!config.googleOAuthEnabled) throw new HttpError(503, 'Google sign-in is not configured.');
  const oauth = new OAuth2Client(config.googleClientId, config.googleClientSecret, redirectUri);
  let tokens;
  try {
    ({ tokens } = await oauth.getToken({ code, codeVerifier, redirect_uri: redirectUri }));
  } catch (err) {
    console.warn('[google] code exchange failed:', err?.message || err);
    throw new HttpError(401, 'Google sign-in failed. Please try again.');
  }
  if (!tokens?.id_token) throw new HttpError(401, 'Google did not return an identity token.');
  return verifyGoogleCredential(tokens.id_token);
}
