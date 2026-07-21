import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { rotateSocialConnectionEncryptionKey } from "@vvugc/shared-auth";
import { loadEnv } from "@vvugc/shared-config";

const oldKey = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY_OLD;
const newKey = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY_NEW;
if (!oldKey || !newKey) {
  throw new Error("Set SOCIAL_TOKEN_ENCRYPTION_KEY_OLD and SOCIAL_TOKEN_ENCRYPTION_KEY_NEW before rotating");
}

const dbPath = join(loadEnv().VVUGC_RUNS_DIR, "social-connections.json");
const backupPath = `${dbPath}.backup-${new Date().toISOString().replaceAll(":", "-")}`;
mkdirSync(dirname(dbPath), { recursive: true });
try {
  copyFileSync(dbPath, backupPath);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const count = rotateSocialConnectionEncryptionKey(dbPath, oldKey, newKey);
console.log(JSON.stringify({ rotatedConnections: count, backupPath }));
