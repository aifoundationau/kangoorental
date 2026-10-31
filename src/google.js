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
