import assert from "node:assert/strict";
import { test } from "node:test";
import { toBase64Url } from "../lib/token.ts";
import { VirtualAuthenticator } from "./virtual-authenticator.ts";
import { authenticationOptions, registrationOptions, verifyAuthentication, verifyRegistration, type RelyingParty } from "./webauthn.ts";

const rp: RelyingParty = { id: "lists.example.com", name: "Household lists", origin: "https://lists.example.com" };

async function registered() {
  const device = await VirtualAuthenticator.create();
  const options = await registrationOptions(rp, { id: "user-1", name: "Aki" }, []);
  const verified = await verifyRegistration(rp, await device.register(options, rp.origin), options.challenge);
  assert.ok(verified);
  return { device, passkey: { id: verified.credentialId, publicKey: verified.publicKey, counter: verified.counter, transports: null } };
}

test("registration options ask for discoverable, user-verified passkeys without attestation", async () => {
  const options = await registrationOptions(rp, { id: "user-1", name: "Aki" }, ["old-credential"]);
  assert.equal(options.rp.id, rp.id);
  assert.equal(options.attestation, "none");
  assert.equal(options.authenticatorSelection?.residentKey, "required");
  assert.equal(options.authenticatorSelection?.userVerification, "required");
  assert.deepEqual(options.excludeCredentials?.map((c) => c.id), ["old-credential"]);
  assert.equal(options.user.name, "Aki");
  assert.ok(options.challenge.length >= 32);
});

test("a registered passkey signs in, and the counter moves forward", async () => {
  const { device, passkey } = await registered();
  assert.equal(passkey.id, device.credentialId);
  const options = await authenticationOptions(rp);
  assert.equal(options.userVerification, "required");
  assert.equal(options.allowCredentials, undefined);
  const counter = await verifyAuthentication(rp, await device.authenticate(options, rp.origin), options.challenge, passkey);
  assert.equal(counter, 1);
});

test("registration is refused for the wrong challenge, origin, relying party or an unverified user", async () => {
  const attempt = async (change: (device: VirtualAuthenticator) => void, origin = rp.origin, expectedRp = rp, challenge?: string) => {
    const device = await VirtualAuthenticator.create();
    change(device);
    const options = await registrationOptions(expectedRp, { id: "u", name: "A" }, []);
    return verifyRegistration(rp, await device.register(options, origin, { challenge }), options.challenge).catch(() => null);
  };
  assert.ok(await attempt(() => {}));
  assert.equal(await attempt(() => {}, "https://evil.example.com"), null);
  assert.equal(await attempt(() => {}, rp.origin, { ...rp, id: "evil.example.com" }), null);
  assert.equal(await attempt(() => {}, rp.origin, rp, toBase64Url(new Uint8Array(32))), null);
  assert.equal(await attempt((d) => (d.userVerifies = false)), null);
});

test("sign-in is refused for a wrong challenge, origin, relying party, tampered signature or unverified user", async () => {
  const { device, passkey } = await registered();
  const options = await authenticationOptions(rp);
  const verify = (response: Awaited<ReturnType<typeof device.authenticate>>, expectedChallenge = options.challenge, stored = passkey) =>
    verifyAuthentication(rp, response, expectedChallenge, stored).catch(() => null);

  assert.equal(await verify(await device.authenticate(options, rp.origin)), 1);
  assert.equal(await verify(await device.authenticate(options, "https://evil.example.com")), null);
  assert.equal(await verify(await device.authenticate(options, rp.origin, { rpId: "evil.example.com" })), null);
  assert.equal(await verify(await device.authenticate(options, rp.origin, { challenge: toBase64Url(new Uint8Array(32)) })), null);
  assert.equal(await verify(await device.authenticate(options, rp.origin), toBase64Url(new Uint8Array(32))), null);

  const forged = await device.authenticate(options, rp.origin);
  forged.response.signature = forged.response.signature.slice(0, -4) + "AAAA";
  assert.equal(await verify(forged), null);

  const stranger = await VirtualAuthenticator.create();
  assert.equal(await verify(await stranger.authenticate(options, rp.origin)), null);

  device.userVerifies = false;
  assert.equal(await verify(await device.authenticate(options, rp.origin)), null);
});

test("a sign-in whose counter goes backwards is refused", async () => {
  const { device, passkey } = await registered();
  const options = await authenticationOptions(rp);
  const response = await device.authenticate(options, rp.origin);
  const cloned = { ...passkey, counter: 50 };
  assert.equal(await verifyAuthentication(rp, response, options.challenge, cloned).catch(() => null), null);
});
