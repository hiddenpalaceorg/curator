import type { Pool } from "pg";

// Visibility is mutable: neither private pages nor currently public crops
// may become permanently readable from a browser/shared cache after revocation.
export const MAG_IMAGE_HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie, X-Moderation-Token",
};

export async function canReadMagImage(pool: Pool, sha256: string, moderator: boolean): Promise<boolean> {
  const result = await pool.query(`SELECT
    EXISTS (SELECT 1 FROM magazine_page p
      JOIN magazine_issue i ON i.id=p.issue_id JOIN magazines m ON m.id=i.magazine_id
      WHERE p.image_sha256=$1 AND (m.pages_public OR $2))
    OR EXISTS (SELECT 1 FROM extract_region r JOIN magazine_extract e ON e.id=r.extract_id
      WHERE r.crop_sha256=$1 AND (e.status<>'rejected' OR $2)) AS allowed`, [sha256, moderator]);
  return result.rows[0]?.allowed === true;
}
