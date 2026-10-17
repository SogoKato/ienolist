import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { fromBase64Url, randomToken, toBase64Url } from "../lib/token.ts";

// A software passkey for tests. It stands in for the browser and the user's device (the one
// external dependency the tests cannot run for real) and does what an authenticator does:
// makes an ES256 key pair, builds authenticator data, and signs. Everything the server
// checks it checks against these genuine bytes and signatures.

// --- the little CBOR needed for a "none" attestation and a COSE key ---------

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function head(major: number, value: number): number[] {
  if (value < 24) return [(major << 5) | value];
  if (value < 256) return [(major << 5) | 24, value];
  return [(major << 5) | 25, value >> 8, value & 255];
}

function cbor(value: Cbor): number[] {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return [...head(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  return [...head(5, value.size), ...[...value].flatMap(([k, v]) => [...cbor(k), ...cbor(v)])];
}

// WebCrypto signs ECDSA as r||s; WebAuthn wants it DER encoded.
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const body = bytes.slice(i);
    return body[0] & 0x80 ? [0x02, body.length + 1, 0, ...body] : [0x02, body.length, ...body];
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

const sha256 = async (data: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
const text = (value: string) => new TextEncoder().encode(value);
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const counterBytes = (n: number) => Uint8Array.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export class VirtualAuthenticator {
  readonly credentialId = randomToken(16);
  userHandle: string | null = null;
  counter = 0;
  // false simulates a device that does not verify the user (no PIN or biometrics).
  userVerifies = true;
  private keys!: { publicKey: CryptoKey; privateKey: CryptoKey };

  static async create(): Promise<VirtualAuthenticator> {
    const authenticator = new VirtualAuthenticator();
    authenticator.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as { publicKey: CryptoKey; privateKey: CryptoKey };
    return authenticator;
  }

  private async clientData(type: string, challenge: string, origin: string) {
    return text(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  private flags(extra = 0) {
    return UP | (this.userVerifies ? UV : 0) | extra;
  }

  // navigator.credentials.create(), for a server's registration options.
  async register(options: PublicKeyCredentialCreationOptionsJSON, origin: string, overrides: { challenge?: string } = {}): Promise<RegistrationResponseJSON> {
    this.userHandle = options.user.id;
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey);
    const cose = new Map<number, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, fromBase64Url(jwk.x!)],
      [-3, fromBase64Url(jwk.y!)],
    ]);
    const credentialId = fromBase64Url(this.credentialId);
    const authData = concat(
      await sha256(text(options.rp.id!)),
      Uint8Array.of(this.flags(AT)),
      counterBytes(this.counter),
      new Uint8Array(16), // aaguid
      Uint8Array.of(credentialId.length >> 8, credentialId.length & 255),
      credentialId,
      Uint8Array.from(cbor(cose)),
    );
    const attestationObject = Uint8Array.from(cbor(new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])));
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: toBase64Url(await this.clientData("webauthn.create", overrides.challenge ?? options.challenge, origin)),
        attestationObject: toBase64Url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  // navigator.credentials.get(), for a server's authentication options.
  async authenticate(
    options: PublicKeyCredentialRequestOptionsJSON,
    origin: string,
    overrides: { challenge?: string; rpId?: string; bumpCounter?: boolean } = {},
  ): Promise<AuthenticationResponseJSON> {
    if (overrides.bumpCounter !== false) this.counter++;
    const clientDataJSON = await this.clientData("webauthn.get", overrides.challenge ?? options.challenge, origin);
    const authData = concat(await sha256(text(overrides.rpId ?? options.rpId!)), Uint8Array.of(this.flags()), counterBytes(this.counter));
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed));
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(derSignature(raw)),
        userHandle: this.userHandle ?? undefined,
      },
    };
  }
}
