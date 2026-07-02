export type DmHistoryMessageRow = {
  content?: string | null;
  media_type?: string | null;
  media_filename?: string | null;
  media_size?: number | null;
  reaction_emoji?: string | null;
  reaction_target_id?: string | null;
  revoked_target_id?: string | null;
  edited_from_id?: string | null;
};

export function formatDmHistoryBody(row: DmHistoryMessageRow): string {
  const mediaParts: string[] = [];
  if (row.media_type) {
    mediaParts.push(row.media_type);
  }
  if (row.media_filename) {
    mediaParts.push(row.media_filename);
  }
  if (row.media_size) {
    mediaParts.push(`${row.media_size} bytes`);
  }
  const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join(", ")}]` : "";
  let body = (row.content ?? "") + mediaSuffix;
  if (row.reaction_emoji) {
    body = `[reaction ${row.reaction_emoji} on ${row.reaction_target_id ?? "?"}]`;
  } else if (row.revoked_target_id) {
    body = `[deleted message ${row.revoked_target_id}]`;
  } else if (row.edited_from_id) {
    body = `[edited ${row.edited_from_id}] ${body}`;
  }
  return body;
}
