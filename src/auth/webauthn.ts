import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { fromBase64Url, toBase64Url } from "../lib/token.ts";

// The relying party: where passkeys are valid. `id` is the site's host name, `origin` its full origin.
export type RelyingParty = { id: string; name: string; origin: string };

export type { AuthenticationResponseJSON, RegistrationResponseJSON };

// Passkeys must be discoverable (sign-in asks for no user name) and verified by the
// user on the device (biometrics or PIN). Attestation is not needed: any passkey will do.
export function registrationOptions(
  rp: RelyingParty,
  user: { id: string; name: string },
  existingCredentialIds: string[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userID: new TextEncoder().encode(user.id),
    userName: user.name,
    userDisplayName: user.name,
    attestationType: "none",
    excludeCredentials: existingCredentialIds.map((id) => ({ id })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
}

export type VerifiedRegistration = { credentialId: string; publicKey: string; counter: number; transports: string[] | null };

export async function verifyRegistration(
  rp: RelyingParty,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<VerifiedRegistration | null> {
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: true,
  });
  if (!result.verified) return null;
  const { credential } = result.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: toBase64Url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? null,
  };
}

export function authenticationOptions(rp: RelyingParty): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({ rpID: rp.id, userVerification: "required" });
}

export type StoredPasskey = { id: string; publicKey: string; counter: number; transports: string | null };

// Returns the authenticator's new signature counter, or null when verification fails.
export async function verifyAuthentication(
  rp: RelyingParty,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  passkey: StoredPasskey,
): Promise<number | null> {
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: true,
    credential: {
      id: passkey.id,
      publicKey: fromBase64Url(passkey.publicKey),
      counter: passkey.counter,
      transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
    },
  });
  return result.verified ? result.authenticationInfo.newCounter : null;
}
