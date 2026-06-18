# Android Theming

The Android app has its own neon-on-near-black look that is **not** shared with
the browser app (`public/app.css` is a separate, dimmer palette). Everything
visual lives in one file:

```
android-app/app/src/main/java/dev/airc/tmuxremote/MainActivity.kt
```

There is no XML layout and no per-widget styles file — the UI is built in code
in `buildUi()`, and colors/shapes come from a small set of helpers. When adding
a new control, reuse those helpers instead of setting raw colors so the new
piece matches automatically.

## Where the colors live

The palette is declared in **three** places that must stay in sync:

1. `MainActivity.Chrome` — the `object` near the top of the file. Native Kotlin
   colors (ARGB ints) for every chrome surface, button, dot, and border. This is
   the source of truth for the native UI (top bar, buttons, dialogs, input row).
2. `terminalHtml()` — the embedded WebView's CSS `:root` block. Mirrors the same
   hex values for the terminal render area (`--bg`, `--surface`, `--primary`,
   `--accent`, `--muted`, `--amber`, `--danger`, plus the `fg-*`/`bg-*` ANSI
   palette). Change a brand color here too or the terminal will drift from the
   chrome around it.
3. `res/values/styles.xml` — `AppTheme` sets `monospace`, the dark status/nav
   bar colors, and `windowLightStatusBar=false`. `applySystemBarColors()` also
   re-applies the bar tints at runtime for older devices.

### Palette (`Chrome`)

| Token | Hex | Use |
|-------|-----|-----|
| `bg` | `#070B0A` | App background, WebView, recessed button fills |
| `surface` | `#0A100E` | Top/bottom bars, dialog & popup backgrounds |
| `primary` | `#9EF56C` | Brand green: primary/active fills, live status |
| `primaryDim` | `#6CC458` | Inactive pane text, input hint |
| `accent` | `#16FFFF` | Cyan: enter key, icon button, dialog OK, section labels |
| `accent2` | `#FF6EC7` | Magenta (ANSI palette only so far) |
| `muted` | `#D5D0AC` | Body/input text |
| `amber` | `#EF9F27` | Connecting / reconnecting status |
| `danger` | `#E24B4A` | Offline status, ANSI red |
| `primaryText` | `#04240F` | Dark text on a `primary` fill |
| `borderAlpha` | `#4D9EF56C` | Default 30%-green stroke |
| `dimBorder` | `#666CC458` | Inactive stroke |
| `wash` | `0x1F9EF56C` | Pressed-state translucent green fill |
| `offlineFill` | `#140909` | Hollow status dot center |
| `radiusDp` | `6` | Corner radius for every rounded shape |

## Building blocks

Use these instead of hand-rolling drawables:

- **`chromeButton(label, kind) { action }`** — the only button factory. Mono
  font, no all-caps, no elevation, press-scale animation, and a `ButtonKind`
  that picks colors. Returns a `Button` you can still tweak (gravity, padding).
- **`ButtonKind`** — the styling enum, resolved in `applyButtonKind()`:
  - `Primary` — green fill, dark text (the **send** button).
  - `Enter` — cyan outline on bg (the **enter** key).
  - `PaneActive` — green fill, dark text (selected pane / top-bar pane button).
  - `PaneInactive` — dim outline on bg (unselected pane rows).
  - `IconAccent` — borderless cyan glyph (the ⚙ settings button).
  - `Key` — green outline on bg (quick keys: `A-`, `A+`, `^`, `v`).
  Each kind also sets a matching `setShadowLayer` glow.
- **`roundedStroke(fill, stroke, radiusDp)`** — a rounded rectangle
  `GradientDrawable`. Used for inputs, popup/dialog backgrounds, and as the base
  of button states. This is also how dialogs get their themed window background:
  `window?.setBackgroundDrawable(roundedStroke(Chrome.surface, Chrome.borderAlpha, Chrome.radiusDp))`.
- **`stateBackground(fill, stroke, pressedFill)`** — a `StateListDrawable` that
  swaps fill on press. `chromeButton` uses it under the hood.
- **`dotDrawable(color, filled, glow)`** — the status indicator dot (filled +
  halo when live, hollow when offline).
- **`dp(value)`** — density helper. All sizing is in `dp(...)`, never raw px.

## Themed dialogs and popups

Stock `AlertDialog`/`PopupWindow` chrome (titles, list items, Material buttons)
does **not** match. The pattern used by `showStatusDetail()`,
`showSettingsMenu()`, and `showPaneDialog()` is:

1. Build the content as a `LinearLayout` (header `TextView` in `accent`, then
   `chromeButton` rows or muted text).
2. For a dialog, `create()` it with `.setView(...)` and **no** title/items, then
   in `setOnShowListener` set the window background to a `roundedStroke` and
   theme any default buttons (mono font + `accent` text).
3. For a popup, set the panel background to `roundedStroke` and a transparent
   `PopupWindow` background.

`showPairDialog()` is the one remaining stock-styled dialog (plain title + two
`EditText`s). It was intentionally left simple; restyle it the same way if its
look starts to matter.

## Checklist for adding a new control

- [ ] Color comes from a `Chrome.*` token — add a token if a genuinely new
      color is needed (and mirror it into `terminalHtml()` if it's a brand color).
- [ ] Buttons go through `chromeButton` with an existing `ButtonKind`; add a kind
      (and a branch in `applyButtonKind`) only for a genuinely new role.
- [ ] Shapes use `roundedStroke`/`stateBackground` and `Chrome.radiusDp`.
- [ ] Sizes/margins/padding use `dp(...)`.
- [ ] Text uses `monoTypeface`, `includeFontPadding = false`.
- [ ] New dialogs/popups follow the themed-dialog pattern above rather than stock
      `setTitle`/`setItems`.
