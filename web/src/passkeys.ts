import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { api, ApiError, type Ceremony, type Me } from "./api";

// A short name for this device, offered as the passkey's label.
export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [browser, os].filter(Boolean).join(" / ");
}

// Asks the server for options, lets the person's device answer, and sends the answer back.
export async function registerPasskey<T>(startPath: string, startBody: object, finishPath: string, deviceName: string): Promise<T> {
  const { challengeId, options } = await api.post<Ceremony<PublicKeyCredentialCreationOptionsJSON>>(startPath, startBody);
  const response = await startRegistration({ optionsJSON: options });
  return api.post<T>(finishPath, { challengeId, response, deviceName: deviceName.trim() || undefined });
}

// No username: the device offers the passkeys it holds for this site.
export async function signInWithPasskey(): Promise<Me> {
  const { challengeId, options } = await api.post<Ceremony<PublicKeyCredentialRequestOptionsJSON>>("/api/login/options");
  const response = await startAuthentication({ optionsJSON: options });
  return api.post<Me>("/api/login/finish", { challengeId, response });
}

// Words for the person, for whatever went wrong.
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "AbortError") return "パスキーの操作が取り消されたか、時間切れになりました。もう一度お試しください。";
  if (name === "InvalidStateError") return "この端末のパスキーは、すでに登録されています。";
  if (name === "NotSupportedError" || name === "SecurityError") return "この端末またはブラウザでは、パスキーを使えません。";
  return "うまくいきませんでした。もう一度お試しください。";
}
