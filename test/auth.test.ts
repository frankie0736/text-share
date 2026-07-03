import {
  createSessionCookie,
  isValidPassword,
  verifySession,
} from "../src/auth";
import type { Env } from "../src/types";

const env: Env = {
  DB: {} as D1Database,
  BUCKET: {} as R2Bucket,
  SHARE_PASSWORD: "test-password",
  SESSION_SECRET: "test-session-secret",
};

describe("auth", () => {
  test("accepts only the configured password", async () => {
    await expect(isValidPassword("test-password", env)).resolves.toBe(true);
    await expect(isValidPassword("wrong", env)).resolves.toBe(false);
  });

  test("verifies a signed session cookie and rejects tampering", async () => {
    const cookie = await createSessionCookie(env, 1_000);
    const request = new Request("https://paste.example/", {
      headers: { cookie },
    });

    await expect(verifySession(request, env, 500)).resolves.toBe(true);

    const tampered = cookie.replace(/[a-f0-9]{8}/, "00000000");
    const tamperedRequest = new Request("https://paste.example/", {
      headers: { cookie: tampered },
    });

    await expect(verifySession(tamperedRequest, env, 500)).resolves.toBe(false);
  });
});
