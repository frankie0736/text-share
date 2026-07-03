import worker, { cleanupExpired } from "../src/index";
import type { Env, ItemRow } from "../src/types";

class FakeR2Object {
  constructor(
    readonly key: string,
    private readonly value: string | ArrayBuffer,
    readonly httpMetadata: R2HTTPMetadata = {},
  ) {}

  get body(): ReadableStream {
    if (typeof this.value === "string") {
      return new Blob([this.value]).stream();
    }
    return new Blob([this.value]).stream();
  }

  writeHttpMetadata(headers: Headers): void {
    if (this.httpMetadata.contentType) {
      headers.set("content-type", this.httpMetadata.contentType);
    }
  }

  async text(): Promise<string> {
    return typeof this.value === "string"
      ? this.value
      : new TextDecoder().decode(this.value);
  }
}

class FakeR2Bucket {
  readonly objects = new Map<string, FakeR2Object>();

  async put(
    key: string,
    value: string | ArrayBuffer | Blob,
    options?: R2PutOptions,
  ): Promise<null> {
    const stored =
      value instanceof Blob ? await value.arrayBuffer() : value;
    this.objects.set(
      key,
      new FakeR2Object(key, stored, options?.httpMetadata),
    );
    return null;
  }

  async get(key: string): Promise<FakeR2Object | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class FakeD1Statement {
  private bindings: unknown[] = [];

  constructor(
    private readonly db: FakeD1Database,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): FakeD1Statement {
    this.bindings = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.sql.includes("WHERE id = ?")) {
      const id = String(this.bindings[0]);
      const now = Number(this.bindings[1] ?? 0);
      const row = this.db.rows.find((item) => {
        if (item.id !== id) return false;
        return this.sql.includes("expires_at > ?") ? item.expires_at > now : true;
      });
      return (row ?? null) as T | null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    if (this.sql.includes("WHERE expires_at > ?")) {
      const now = Number(this.bindings[0]);
      return {
        results: this.db.rows
          .filter((item) => item.expires_at > now)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 100) as T[],
        success: true,
        meta: {},
      };
    }
    if (this.sql.includes("WHERE expires_at <= ?")) {
      const now = Number(this.bindings[0]);
      const limit = Number(this.bindings[1]);
      return {
        results: this.db.rows
          .filter((item) => item.expires_at <= now)
          .slice(0, limit)
          .map((item) => ({ id: item.id, r2_key: item.r2_key })) as T[],
        success: true,
        meta: {},
      };
    }
    return { results: [], success: true, meta: {} };
  }

  async run(): Promise<D1Result> {
    const normalizedSql = this.sql.trimStart();
    if (normalizedSql.startsWith("INSERT INTO items")) {
      const [
        id,
        kind,
        r2Key,
        fileName,
        fileType,
        fileSize,
        createdAt,
        expiresAt,
      ] = this.bindings;
      this.db.rows.push({
        id: String(id),
        kind: kind as ItemRow["kind"],
        r2_key: r2Key === null ? null : String(r2Key),
        file_name: fileName === null ? null : String(fileName),
        file_type: fileType === null ? null : String(fileType),
        file_size: fileSize === null ? null : Number(fileSize),
        created_at: Number(createdAt),
        expires_at: Number(expiresAt),
      });
      return { results: [], success: true, meta: {} };
    }
    if (normalizedSql.startsWith("DELETE FROM items")) {
      const id = String(this.bindings[0]);
      this.db.rows = this.db.rows.filter((item) => item.id !== id);
      return { results: [], success: true, meta: {} };
    }
    return { results: [], success: true, meta: {} };
  }
}

class FakeD1Database {
  rows: ItemRow[] = [];

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(this, sql);
  }
}

function makeEnv(): Env & { DB: FakeD1Database; BUCKET: FakeR2Bucket } {
  return {
    DB: new FakeD1Database(),
    BUCKET: new FakeR2Bucket(),
    SHARE_PASSWORD: "test-password",
    SESSION_SECRET: "test-session-secret",
  };
}

async function login(env: Env): Promise<string> {
  const response = await worker.fetch(
    new Request("https://paste.example/login", {
      method: "POST",
      body: new URLSearchParams({ password: "test-password" }),
    }),
    env,
    {} as ExecutionContext,
  );
  return response.headers.get("set-cookie") ?? "";
}

describe("worker", () => {
  test("requires login before showing or downloading shared content", async () => {
    const env = makeEnv();

    const home = await worker.fetch(
      new Request("https://paste.example/"),
      env,
      {} as ExecutionContext,
    );

    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe("/login");
  });

  test("creates markdown text without requiring type or title and renders it as an escaped code block", async () => {
    const env = makeEnv();
    const cookie = await login(env);
    const body = new FormData();
    body.set("content", "## Deploy\n<script>alert(1)</script>");
    body.set("ttl_days", "7");

    const created = await worker.fetch(
      new Request("https://paste.example/texts", {
        method: "POST",
        headers: { cookie },
        body,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(created.status).toBe(303);
    expect(env.DB.rows).toHaveLength(1);
    expect(env.DB.rows[0].kind).toBe("text");
    expect(env.DB.rows[0].file_name).toBe("text.md");
    expect(env.BUCKET.objects.has(env.DB.rows[0].r2_key ?? "")).toBe(true);

    const home = await worker.fetch(
      new Request("https://paste.example/", { headers: { cookie } }),
      env,
      {} as ExecutionContext,
    );
    const html = await home.text();

    expect(html).toContain('class="layout"');
    expect(html).toContain("Markdown 文本");
    expect(html).toContain("文档上传");
    expect(html).toContain("<pre><code id=");
    expect(html).toContain("## Deploy");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('name="kind"');
    expect(html).not.toContain('name="title"');
    expect(html).not.toContain('name="url"');
  });

  test("rejects empty markdown text and TTL values outside 1 to 1095 days", async () => {
    const env = makeEnv();
    const cookie = await login(env);
    const emptyText = new FormData();
    emptyText.set("content", "   ");
    emptyText.set("ttl_days", "7");

    const emptyTextResponse = await worker.fetch(
      new Request("https://paste.example/texts", {
        method: "POST",
        headers: { cookie },
        body: emptyText,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(emptyTextResponse.status).toBe(400);

    const invalidTtl = new FormData();
    invalidTtl.set("content", "content");
    invalidTtl.set("ttl_days", "1096");

    const invalidTtlResponse = await worker.fetch(
      new Request("https://paste.example/texts", {
        method: "POST",
        headers: { cookie },
        body: invalidTtl,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(invalidTtlResponse.status).toBe(400);
    expect(env.DB.rows).toHaveLength(0);
  });

  test("creates document uploads without type or title and renders upload date in descending order", async () => {
    const env = makeEnv();
    const cookie = await login(env);
    const body = new FormData();
    body.set("file", new File(["hello"], "spec.md", { type: "text/markdown" }));
    body.set("ttl_days", "7");

    const created = await worker.fetch(
      new Request("https://paste.example/documents", {
        method: "POST",
        headers: { cookie },
        body,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(created.status).toBe(303);
    expect(env.DB.rows).toHaveLength(1);
    expect(env.DB.rows[0].kind).toBe("document");
    expect(env.DB.rows[0].file_name).toBe("spec.md");
    expect(env.DB.rows[0].file_size).toBe(5);

    const home = await worker.fetch(
      new Request("https://paste.example/", { headers: { cookie } }),
      env,
      {} as ExecutionContext,
    );
    const html = await home.text();

    expect(html).toContain('<span class="file-name-text">spec.md</span>');
    expect(html).toContain('<span class="file-size-inline">5 B</span>');
    expect(html).toContain("上传日期");
    expect(html).toContain('title="点击复制链接"');
    expect(html).toContain('class="download-icon"');
    expect(html).toContain('aria-label="下载"');
    expect(html).toContain(">⇩</a>");
    const documentItemStart = html.indexOf('<div class="document-item"');
    expect(html.indexOf('class="download-icon"', documentItemStart)).toBeLessThan(
      html.indexOf('class="icon-delete"', documentItemStart),
    );
    expect(html).toContain('data-dropzone="true"');
  });

  test("renders text and document lists by created_at descending", async () => {
    const env = makeEnv();
    const cookie = await login(env);
    env.DB.rows.push(
      {
        id: "old-text",
        kind: "text",
        r2_key: "texts/old-text.md",
        file_name: "text.md",
        file_type: "text/markdown; charset=utf-8",
        file_size: 8,
        created_at: 100,
        expires_at: 9_999_999_999,
      },
      {
        id: "new-text",
        kind: "text",
        r2_key: "texts/new-text.md",
        file_name: "text.md",
        file_type: "text/markdown; charset=utf-8",
        file_size: 8,
        created_at: 200,
        expires_at: 9_999_999_999,
      },
      {
        id: "old-doc",
        kind: "document",
        r2_key: "documents/old-doc/old.pdf",
        file_name: "old.pdf",
        file_type: "application/pdf",
        file_size: 3,
        created_at: 100,
        expires_at: 9_999_999_999,
      },
      {
        id: "new-doc",
        kind: "document",
        r2_key: "documents/new-doc/new.pdf",
        file_name: "new.pdf",
        file_type: "application/pdf",
        file_size: 3,
        created_at: 200,
        expires_at: 9_999_999_999,
      },
    );
    await env.BUCKET.put("texts/old-text.md", "old text");
    await env.BUCKET.put("texts/new-text.md", "new text");
    await env.BUCKET.put("documents/old-doc/old.pdf", "old");
    await env.BUCKET.put("documents/new-doc/new.pdf", "new");

    const home = await worker.fetch(
      new Request("https://paste.example/", { headers: { cookie } }),
      env,
      {} as ExecutionContext,
    );
    const html = await home.text();

    expect(html.indexOf("new text")).toBeLessThan(html.indexOf("old text"));
    expect(html.indexOf("new.pdf")).toBeLessThan(html.indexOf("old.pdf"));
  });

  test("document downloads only after login and oversized uploads are blocked", async () => {
    const env = makeEnv();
    const cookie = await login(env);
    const body = new FormData();
    body.set("file", new File(["hello"], "spec.md", { type: "text/markdown" }));
    body.set("ttl_days", "7");

    const created = await worker.fetch(
      new Request("https://paste.example/documents", {
        method: "POST",
        headers: { cookie },
        body,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(created.status).toBe(303);
    const item = env.DB.rows[0];

    const unauthenticatedDownload = await worker.fetch(
      new Request(`https://paste.example/items/${item.id}/download`),
      env,
      {} as ExecutionContext,
    );
    expect(unauthenticatedDownload.status).toBe(303);

    const download = await worker.fetch(
      new Request(`https://paste.example/items/${item.id}/download`, {
        headers: { cookie },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("hello");

    const oversized = new FormData();
    oversized.set(
      "file",
      new File([new Uint8Array(25 * 1024 * 1024 + 1)], "big.zip"),
    );
    oversized.set("ttl_days", "7");

    const oversizedResponse = await worker.fetch(
      new Request("https://paste.example/documents", {
        method: "POST",
        headers: { cookie },
        body: oversized,
      }),
      env,
      {} as ExecutionContext,
    );

    expect(oversizedResponse.status).toBe(413);
  });

  test("deletes text and removes expired R2 objects during scheduled cleanup", async () => {
    const env = makeEnv();
    const cookie = await login(env);
    const note = new FormData();
    note.set("content", "delete me");
    note.set("ttl_days", "7");

    await worker.fetch(
      new Request("https://paste.example/texts", {
        method: "POST",
        headers: { cookie },
        body: note,
      }),
      env,
      {} as ExecutionContext,
    );

    const item = env.DB.rows[0];
    expect(env.BUCKET.objects.has(item.r2_key ?? "")).toBe(true);

    const deleted = await worker.fetch(
      new Request(`https://paste.example/items/${item.id}/delete`, {
        method: "POST",
        headers: { cookie },
      }),
      env,
      {} as ExecutionContext,
    );

    expect(deleted.status).toBe(303);
    expect(env.DB.rows).toHaveLength(0);
    expect(env.BUCKET.objects.has(item.r2_key ?? "")).toBe(false);

    env.DB.rows.push({
      id: "expired",
      kind: "text",
      r2_key: "notes/expired.md",
      file_name: "expired.md",
      file_type: "text/markdown",
      file_size: 5,
      created_at: 1,
      expires_at: 1,
    });
    await env.BUCKET.put("notes/expired.md", "stale");

    const result = await cleanupExpired(env, 2);

    expect(result.deleted).toBe(1);
    expect(env.DB.rows).toHaveLength(0);
    expect(env.BUCKET.objects.has("notes/expired.md")).toBe(false);
  });
});
