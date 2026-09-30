# Desktop background

Settings → Appearance → Terminal → Advanced → Window → Desktop background:

- **Solid (transparency off)**: ordinary Orca; the theme daemon is not contacted.
- **Shared wallpaper**: displays the local theme daemon's image behind the workspace.
- **Transparent window**: shows the desktop/windows behind Orca. Enabling this on an opaque window requires a restart; switching back to solid or image is immediate. Restart in solid/image mode to release native alpha compositing too.

UI background opacity controls one tint layer. Existing terminal background opacity still takes precedence; when unset, terminals use 0.78 opacity in image/transparent mode and are opaque in solid mode. Menus, dialogs, editors and browser guests retain their opaque surfaces for readability. Native transparency depends on the platform's window compositor; it does not enable vibrancy/acrylic.

## Theme daemon contract

Like `shin902/screen-transparency`, Orca uses the existing loopback service, not a new webhook receiver:

- `ws://127.0.0.1:17321/v1/events`: `ready`, `wallpaper_changed` (also accepts `theme_changed`) trigger a theme read.
- `GET /v1/theme`: `{ "theme": { "revision": 1, "wallpaperUrl": "/v1/wallpaper?revision=1" } }`.
- `wallpaper_transparency_changed`: boolean `enabled` temporarily turns the selected background off/on without changing the user's mode. The daemon sends its current state on connection.
- JSON `ping` every 20 seconds, with reconnect after lost contact. A periodic theme read also retries failed downloads; unchanged revisions do not redownload images.

Downloads are restricted to the same loopback origin, reject redirects, and accept only PNG/JPEG/WebP (20 MiB maximum, 10-second timeout). Failure keeps the last downloaded wallpaper in memory; a fresh launch without the daemon falls back to solid. No image is saved into settings, session snapshots or remote payloads.

The Electron main window owns the connection, including for SSH and folder workspaces. Nothing is fetched from an SSH host; the browser client does not connect to its own localhost. Solid remains the default, so ordinary windows keep the opaque rendering path.

## Upstream integration points

Implementation is isolated in `theme-daemon-client.ts`, `desktop-background-window.ts`, `DesktopBackground.tsx`, `DesktopBackgroundSettings.tsx`, and `desktop-background.css`. Existing files only connect window creation, the preload subscription, the app root, settings, and shared terminal opacity resolution. No changes to base color tokens or shadcn primitives are needed.
