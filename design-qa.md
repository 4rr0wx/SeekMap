# Mobile question panel design QA

- Source visual truth: `C:\Users\marti\.codex\codex-remote-attachments\01a09eb7-d1ef-7370-9bf7-42ced800cffe\5C7B3B38-657A-40D2-AA36-5EE8B790CDE3\1-Eingefügtes-Bild-1.jpg`
- Source pixels: 590 x 1280. The screenshot includes iOS and browser chrome, so it is problem evidence rather than a pixel-for-pixel target.
- Implementation: Codex in-app Browser capture of `http://127.0.0.1:3104/` in the Hider `PENDING` Thermometer state. The browser capture surface did not expose a filesystem path.
- Viewports: phone 327 x 910 CSS px, iPad 820 x 1180 CSS px, desktop regression check 1280 x 900 CSS px; device scale factor was browser-managed.
- State: one pending Thermometer question, Hider Assistance enabled, location unavailable.

## Full-view comparison evidence

The source shows the question sheet covering most of the phone map between the header and bottom navigation. In the revised phone capture, the default question surface is a 76 px summary bar above the bottom navigation, leaving the map usable. The expanded capture keeps the question content scrollable within 62dvh and leaves the header, map context, and bottom navigation visible. On iPad, the same compact default prevents the previous 390 px wide, full-height overlay. Desktop retains the permanent 379 px activity rail and hides the mobile toggle.

## Focused region comparison evidence

The compact question control was checked in both states. It exposes the current status and title while collapsed, has a 38 x 38 px chevron target inside a 74 px high button, reports `aria-expanded`, and restores the full prompt, local-location help, and Hotter/Colder actions when expanded.

## Findings

- No actionable P0, P1, or P2 issues remain.
- Fonts and typography: existing product typography and status hierarchy are preserved; the mobile title truncates instead of pushing the chevron off-screen.
- Spacing and layout rhythm: the collapsed bar clears the bottom navigation and safe-area offset; no horizontal overflow was measured at 327, 820, or 1280 px.
- Colors and visual tokens: the new control uses the existing panel, cream, gold, line, radius, and shadow tokens.
- Image quality and asset fidelity: no new raster assets are involved; existing Lucide chevrons match the application's icon language.
- Copy and content: the status, question title, prompt, GPS explanation, and answer labels remain intact.
- Interaction and accessibility: collapse/expand worked in the rendered browser, the disclosure state was announced, and the browser console contained no errors.

## Comparison history

1. Initial iPad check found the existing activity sidebar still occupied a 390 x 1004 px overlay at 820 x 1180.
2. The collapsible breakpoint was extended from phone-only to all viewports below the 1100 px desktop rail breakpoint.
3. Post-fix evidence measured the iPad panel at 390 x 76 px collapsed and 390 x 363.75 px expanded; the phone panel measured 76 px collapsed and exposed all actions expanded.

## Implementation checklist

- [x] Compact default question summary on phone and tablet.
- [x] Working expand/collapse control with accessible state.
- [x] Full answer workflow remains available when expanded.
- [x] Desktop activity rail remains permanently visible.
- [x] Phone, iPad, desktop, and browser-console checks completed.

## Follow-up polish

No P3 items are required for this change.

final result: passed
