# Manual accessibility and screen-reader checklist

Automated checks cannot prove what assistive technology announces. This
checklist covers the `@nestvexa/ui` primitives and the admin example
(examples/admin-i18n, README in that directory). It must be run by a person
before a release.

> **Status: not executed.** The agent that wrote these primitives ran only
> automated checks: axe-core plus keyboard and focus assertions in Chromium
> ([`tests/ui-browser.test.ts`](../../tests/ui-browser.test.ts)) and the
> admin example's three-browser Playwright suite. None of the manual steps
> below have been carried out. Record results (date, versions, tester, pass or
> fail, notes) in the release checklist when they are.

## Environments

Test at least these pairings, using current stable versions:

| Screen reader | Browser | Platform        |
| ------------- | ------- | --------------- |
| NVDA          | Firefox | Windows         |
| JAWS          | Chrome  | Windows         |
| VoiceOver     | Safari  | macOS           |
| VoiceOver     | Safari  | iOS (touch)     |
| TalkBack      | Chrome  | Android (touch) |

Run every section in English (LTR) and Arabic (RTL), with the optional theme
in light and dark mode.

## Dialog (`uiDialog`, `uiDialogTrigger`)

- [ ] The trigger is announced as a button with its label and a popup/dialog
      hint (from `aria-haspopup="dialog"`).
- [ ] On open, the dialog role and its title are announced, and the virtual
      cursor or browse mode starts inside the dialog.
- [ ] Initial focus lands on the first form field (or `[autofocus]`), not
      behind the dialog.
- [ ] Tab and Shift+Tab never reach page content behind the dialog. Swipe
      navigation on iOS and Android does not reach it either.
- [ ] Browse-mode or rotor navigation (headings, landmarks) does not expose
      background content while the dialog is open.
- [ ] Escape, the close button (announced as "Close" or its translation) and
      a successful save each close the dialog and return focus to the trigger,
      which is announced again.
- [ ] Without JavaScript, the `href` trigger opens the equivalent full page.

## Tabs (`uiTabs`)

- [ ] The tablist is announced with its label, with "tab N of M" and the
      selected state.
- [ ] Only the selected tab is in the Tab order. Arrow keys move between
      tabs and the panel changes immediately (automatic activation).
- [ ] In Arabic, Left Arrow moves to the visually next (left-hand) tab.
- [ ] Tab moves from the tablist into the panel. The panel is announced with
      the tab's name.
- [ ] Without JavaScript, all panels are readable in order and no empty
      tablist is announced.

## Combobox (`uiCombobox`)

- [ ] It is announced as an editable combobox with its label, collapsed state
      and autocomplete hint.
- [ ] Typing announces the result count ("3 results") or the empty message.
- [ ] Down Arrow announces the active option (from `aria-activedescendant`)
      with its position, and the selected state follows.
- [ ] Enter commits: the input value is announced and the list collapses.
- [ ] Escape closes the list. A second Escape clears the input. In a dialog,
      Escape on an empty, closed combobox closes the dialog.
- [ ] Touch: options can be activated by double-tap.

## Toasts (`uiToastRegion`)

- [ ] A success message triggered by an action is announced politely, once,
      without moving focus.
- [ ] An error toast is announced assertively.
- [ ] Message text containing markup is read literally.
- [ ] The dismiss button is reachable and labelled. Hovering or focusing a
      toast keeps it visible (no time limit while it has attention).
- [ ] Each region landmark ("Notifications") appears once in the landmarks
      list.

## Data table, sort and pagination

- [ ] The table caption is announced. Column headers are announced when moving
      between cells.
- [ ] Only the sorted column announces "sorted ascending" or "sorted
      descending". After activating a header, the new sort state is announced
      on the header (re-focus if necessary).
- [ ] The pagination navigation landmark is labelled. The current page is
      announced as current ("current page"). Ellipses are not announced.
      Disabled previous and next links are announced as unavailable.

## Disclosure and progress

- [ ] Summary is announced as expandable with its expanded/collapsed state.
- [ ] Progress is announced with its label and value or value text.
      Indeterminate progress is announced as busy or indeterminate.

## Admin example scenarios

- [ ] Switching language to العربية announces the page in Arabic. Reading
      order follows the RTL layout, and `lang` changes the speech voice.
- [ ] The AI assistant panel announces streaming status. The tool-approval
      request is announced with what it will do. Approve and Reject are
      clearly labelled. Cancelling a stream announces that it stopped.
- [ ] A restored offline draft is announced as restored and not yet
      submitted. Nothing is submitted without an explicit action.
- [ ] Feature-flagged sections that are off are absent, not merely hidden
      visually.

## Visual and motor checks

- [ ] 200% and 400% browser zoom (WCAG 1.4.10 reflow at 320 CSS px): no
      horizontal scrolling for the dialog, tabs, table (the table may scroll
      inside its own container), toasts or combobox list.
- [ ] Text spacing override (WCAG 1.4.12) does not clip labels.
- [ ] Windows High Contrast / forced colors: focus rings, selected tab, active
      option and current page remain distinguishable.
- [ ] `prefers-reduced-motion: reduce`: no dialog or toast animation.
- [ ] Focus is always visible, and is never obscured by toasts (WCAG 2.4.11).
- [ ] Targets are at least 24×24 CSS px (WCAG 2.5.8). Primitive controls in
      the theme use 40px.
- [ ] Every action is operable by keyboard alone, with no keyboard traps
      outside the intentional modal dialog trap.

## Known exceptions

- The combobox needs JavaScript to choose a value. Forms must validate on the
  server and offer a non-JavaScript path where the choice is critical.
- Dialogs need JavaScript. The `href` fallback page is the non-JavaScript
  equivalent.
- These primitives have no SPA adapters. Their screen-reader behavior has been
  reasoned about from the WAI-ARIA Authoring Practices, not observed.
