# Fieldroom in Google AI Studio

Use `AI_STUDIO_MIGRATION_PROMPT.md` for the migration prompt and import steps. AI Studio's documented existing-code path is **Build mode → Add files (+) → Import from GitHub**. This local folder is not currently connected to a GitHub repository.

The local Node server now binds to `0.0.0.0` when a managed runtime supplies `PORT`; ordinary local launch remains loopback-only. A `dev` command is also available for runtimes that start Node apps with `npm run dev`.

The current hosted mode is not automatically compatible with AI Studio's Firebase integration. Build mode must adapt sign-in and Firestore persistence while keeping the app private, preserving the server-side access allowlist, and maintaining all existing Fieldroom features. Do not upload local data or construction documents as build context. Local project state and files will not migrate automatically.

AI Studio's no-billing Starter Tier is limited to eligible accounts. If Publish asks for billing or payment details, cancel. Standard Cloud Run deployment requires a linked Google Cloud project with billing. The app has not been imported or published.
