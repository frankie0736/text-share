export type ItemKind = "text" | "document";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  SHARE_PASSWORD: string;
  SESSION_SECRET: string;
}

export interface ItemRow {
  id: string;
  kind: ItemKind;
  r2_key: string;
  file_name: string | null;
  file_type: string | null;
  file_size: number | null;
  created_at: number;
  expires_at: number;
}

export interface RenderItem extends ItemRow {
  text_body?: string;
}
