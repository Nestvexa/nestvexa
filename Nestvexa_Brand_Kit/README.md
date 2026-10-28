# Nestvexa — Visual Identity & Design System (Draft v1.0)

## Design direction
A minimalist, flat, two-part connected symbol — representing frontend + backend as one system. The chosen palette is restrained jade and graphite; **no purple, gradients, glow, 3D or AI-style gloss**.

**Official project name:** Nestvexa  
**Display wordmark:** `nestvexa` (lowercase)  
**Tagline proposal:** One backend. Infinite frontend possibilities.

## Brand colors
| Token | Hex | Usage |
| --- | --- | --- |
| Jade / primary | #0E9F79 | Identity, logo accent, small highlights |
| Jade / accessible CTA | #0B765D | White-text buttons on light backgrounds |
| Jade / pressed | #065942 | Active/pressed actions |
| Graphite | #111C25 | Mark, text, navigation |
| Canvas | #F8FAF8 | Light background |
| Soft Jade | #DFF5EC | Subtle panels, pill backgrounds |
| Muted | #61717A | Secondary text |
| Borders | #D7E2DD | Dividers, borders |
| Night | #0C151B | Dark site background |
| Dark surface | #16232C | Dark cards |

### Accessibility
#0E9F79 with white text is about 3.36:1, so it does **not** meet WCAG AA for normal 16px text. Use #0B765D (5.58:1 on white) for white-text CTAs. Dark text #111C25 on the light primary Jade exceeds 5:1. Always check actual foreground/background contrast.

## Typography
- UI & Body: **Inter** (open-source). Do not redistribute font binaries in this kit.
- Display: **Inter Display** (or Inter SemiBold).
- Code: **JetBrains Mono** (fallback to IBM Plex Mono).
- Type scale: 12, 14, 16, 18, 20, 24, 30, 36, 48 px.
- Default body line height 1.6; headings 1.1–1.25; mild negative tracking only on major headings.

## Layout foundations
- Spacing: 4px grid; tokens 4,8,12,16,20,24,32,40,48,64 px.
- Radii: 6 / 10 / 14 / 18 px, pill 999px.
- Borders: 1px subtle; focus outline: visible 3px.
- Container max width: 1200px; docs sidebar: 248px.
- Motion: 120ms fast; 180ms standard; 280ms slow; respect reduced-motion.

## Logo rules
- Favor two-color symbol: graphite + jade, on warm white.
- On dark: use white + jade, or 1-color white mark.
- Small symbol digital minimum: 24px; test at 16px for favicons.
- Clear space: >=20% of mark height on all sides.
- Never skew, rotate, bevel, add shadows, gradients or visual effects.
- Do not put complex patterns directly behind the icon.
- A 1-color black/white variant must remain fully recognizable.

## Components
- Solid CTA: deep Jade background, white text, 10px radius; show hover/disabled/working states.
- Focus: 3px visible mint outline with offset; never remove keyboard focus.
- Cards: white surface + subtle border, 14px radius, padding 24px.
- Inputs: 1px border, at least 44px hit target, explicit labels/error/help.
- Status colors: success green, info blue, warning amber, error red; add icons/text for accessibility.
- Navigation: active indicator can use Jade but must not rely only on color.
- Syntax blocks: dark neutral background, independent accessible code palette.

## Source files
- `logos/` vector SVG logo family including true text-to-outline paths (no font dependencies)
- `png/` common-size raster exports
- `tokens/nestvexa.tokens.json` reference token data
- `tokens/nestvexa.css` copy-ready CSS variables and example button/card styles
- `examples/docs-landing-reference.html` minimal HTML example
- `Nestvexa_Brand_Guidelines.pdf` 11-page design specification

## Governance
This is **brand concept v1**, not a registered trademark, and logo uniqueness has not been legally cleared. Compare against relevant software trademarks and logo marks prior to public launch. Review SVGs in light/dark and at 16px, 24px, 32px. Brand improvements should be proposed through public PRs, with visual diff screenshots and token migration plans.
