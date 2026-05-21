/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Vault location relative to the home dir. Override per machine via
   *  a gitignored `.env.local` (e.g. VITE_VAULT_SUBPATH=Development/Dropbox/Home).
   *  Defaults to "Documents/Dropbox/Home" when unset. */
  readonly VITE_VAULT_SUBPATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
