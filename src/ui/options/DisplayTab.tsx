// The Display tab: how the panel looks and what it shows, in sections: the
// panel's look, its buttons, what it shows, trade pop-ups, a background image,
// and how it sits on the page. Each setting is a row: what it is on the left,
// the control on the right.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { WalletState } from '../../messages';
import type { Settings } from '../../settings/schema';
import { useSettingsDraft } from './settingsDraft';
import { savePanelImage, shrinkImage, watchPanelImage } from '../panelImage';
import { playResult } from '../sounds';

type Ui = Settings['ui'];

/** One setting: its name and a short hint, then its control. */
function Row({ title, hint, children }: { title: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="setting">
      <span class="what">
        <b>{title}</b>
        {hint && <small>{hint}</small>}
      </span>
      <span class="control">{children}</span>
    </label>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ComponentChildren }) {
  return (
    <>
      <h2>{title}</h2>
      {hint && <p class="muted section-hint">{hint}</p>}
      <div class="card settings">{children}</div>
    </>
  );
}

export function DisplayTab({ state, refresh }: { state: WalletState; refresh(): void }) {
  const { s, setS, save, status, setErr } = useSettingsDraft(state, refresh);
  // The background image is stored on its own, as soon as it's chosen (its opacity saves with the settings).
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => watchPanelImage(setImage), []);
  const num = (e: Event) => Number((e.target as HTMLInputElement).value);
  const checked = (e: Event) => (e.target as HTMLInputElement).checked;
  const value = <T,>(e: Event) => (e.target as HTMLSelectElement).value as T;
  const ui = (patch: Partial<Ui>) => setS({ ...s, ui: { ...s.ui, ...patch } });
  const show = (patch: Partial<Ui['show']>) => ui({ show: { ...s.ui.show, ...patch } });
  const toggle = (on: boolean, set: (on: boolean) => void) => <input type="checkbox" class="switch" checked={on} onChange={(e) => set(checked(e))} />;
  const rowsSelect = (n: number, set: (n: number) => void) => (
    <select value={n} onChange={(e) => set(num(e))}>
      <option value={1}>1 row</option>
      <option value={2}>2 rows</option>
      <option value={3}>3 rows</option>
    </select>
  );
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const popupsOff = !s.ui.show.tradeToasts;

  return (
    <>
      <Section title="Look">
        <Row title="Theme" hint="Auto follows your system">
          <select value={s.ui.theme} onChange={(e) => ui({ theme: value<Ui['theme']>(e) })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="auto">Auto</option>
          </select>
        </Row>
        <Row title="Accent colour" hint="The active tab, highlights and focus rings">
          <input type="color" value={s.ui.accent} onChange={(e) => ui({ accent: (e.target as HTMLInputElement).value })} />
        </Row>
        <Row title="Panel colour" hint={s.ui.panelBg ? 'A colour of your own' : 'Follows the theme'}>
          <span class="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
            <input type="color" value={s.ui.panelBg ?? '#1c1c1c'} onChange={(e) => ui({ panelBg: (e.target as HTMLInputElement).value })} />
            {s.ui.panelBg && (
              <button type="button" onClick={() => ui({ panelBg: null })}>
                Reset
              </button>
            )}
          </span>
        </Row>
        <Row title="Size" hint={pct(s.ui.scale)}>
          <input type="range" min="0.6" max="1.6" step="0.05" value={s.ui.scale} onInput={(e) => ui({ scale: num(e) })} />
        </Row>
        <Row title="Opacity" hint={pct(s.ui.opacity)}>
          <input type="range" min="0.5" max="1" step="0.05" value={s.ui.opacity} onInput={(e) => ui({ opacity: num(e) })} />
        </Row>
        <Row title="Layout" hint="Compact shrinks the buttons and spacing">
          <select value={s.ui.layout} onChange={(e) => ui({ layout: value<Ui['layout']>(e) })}>
            <option value="full">Full</option>
            <option value="compact">Compact</option>
          </select>
        </Row>
      </Section>

      <Section title="Buttons">
        <Row title="Buy rows" hint="Four buttons per row; edit amounts with the panel's pencil">
          {rowsSelect(s.ui.rows.buy, (buy) => ui({ rows: { ...s.ui.rows, buy } }))}
        </Row>
        <Row title="Sell rows">{rowsSelect(s.ui.rows.sell, (sell) => ui({ rows: { ...s.ui.rows, sell } }))}</Row>
        <Row title="Sell buttons" hint="What the sell buttons sell">
          <select value={s.ui.sellRows} onChange={(e) => ui({ sellRows: value<Ui['sellRows']>(e) })}>
            <option value="follow">% or SOL, with a switch</option>
            <option value="mixed">SOL on the first row, % below</option>
            <option value="pct">Always %</option>
          </select>
        </Row>
        <Row title="Button shape">
          <select value={s.ui.buttonShape} onChange={(e) => ui({ buttonShape: value<Ui['buttonShape']>(e) })}>
            <option value="square">Square, joined</option>
            <option value="rounded">Rounded, separate</option>
          </select>
        </Row>
      </Section>

      <Section title="What the panel shows">
        <Row title="PnL footer" hint="Bought, sold, holding and PnL along the bottom">
          {toggle(s.ui.show.pnl, (pnl) => show({ pnl }))}
        </Row>
        <Row title="Your holdings" hint="Tokens, USD and SOL in the sell header">
          {toggle(s.ui.show.tokenAmounts, (tokenAmounts) => show({ tokenAmounts }))}
        </Row>
        <Row title="SOL / % labels" hint="Next to Buy and Sell, with the sell switch">
          {toggle(s.ui.show.currencySwitch, (currencySwitch) => show({ currencySwitch }))}
        </Row>
        <Row title="Fees saved" hint={'“Saved … vs a 1% platform fee” under the panel'}>
          {toggle(s.ui.show.feesSaved, (feesSaved) => show({ feesSaved }))}
        </Row>
      </Section>

      <Section title="Trade pop-ups" hint="The notes that show a trade being sent and landing. Failures always show.">
        <Row title="Show trade pop-ups">{toggle(s.ui.show.tradeToasts, (tradeToasts) => show({ tradeToasts }))}</Row>
        <div class={popupsOff ? 'dimmed' : ''}>
          <Row title="Position">
            <select value={s.ui.toastPosition} onChange={(e) => ui({ toastPosition: value<Ui['toastPosition']>(e) })}>
              <option value="panel">Under the panel</option>
              <option value="top-left">Top left</option>
              <option value="top-center">Top middle</option>
              <option value="top-right">Top right</option>
              <option value="bottom-left">Bottom left</option>
              <option value="bottom-center">Bottom middle</option>
              <option value="bottom-right">Bottom right</option>
            </select>
          </Row>
          <Row title="Duration" hint={`${s.ui.toastSeconds} seconds each`}>
            <input type="range" min="1" max="30" step="1" value={s.ui.toastSeconds} onInput={(e) => ui({ toastSeconds: num(e) })} />
          </Row>
          <Row title="At once" hint={`Up to ${s.ui.toastMax}; older ones drop off first`}>
            <input type="range" min="1" max="4" step="1" value={s.ui.toastMax} onInput={(e) => ui({ toastMax: num(e) })} />
          </Row>
        </div>
        <Row title="Sound" hint="When a trade lands or fails">
          {toggle(s.ui.sound.enabled, (enabled) => ui({ sound: { ...s.ui.sound, enabled } }))}
        </Row>
        {s.ui.sound.enabled && (
          <Row title="Volume" hint={pct(s.ui.sound.volume)}>
            <span class="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <input type="range" min="0" max="1" step="0.05" value={s.ui.sound.volume} onInput={(e) => ui({ sound: { ...s.ui.sound, volume: num(e) } })} />
              <button type="button" onClick={() => playResult('landed', s.ui.sound.volume)}>
                Landed
              </button>
              <button type="button" onClick={() => playResult('failed', s.ui.sound.volume)}>
                Failed
              </button>
            </span>
          </Row>
        )}
      </Section>

      <Section title="Background image" hint="Drawn over the panel colour, under the buttons. Stored only in this browser.">
        <div class="row" style={{ alignItems: 'center', gap: 16, padding: '12px 0' }}>
          <div
            style={{
              width: 112,
              height: 112,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: s.ui.panelBg ?? '#1c1c1c',
              position: 'relative',
              overflow: 'hidden',
              flex: 'none',
            }}
            title="Preview"
          >
            {image && <img src={image} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: s.ui.panelImageOpacity }} />}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
            <div class="row" style={{ gap: 8 }}>
              <label class="button" style={{ cursor: 'pointer' }}>
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const f = (e.target as HTMLInputElement).files?.[0];
                    (e.target as HTMLInputElement).value = '';
                    if (!f) return;
                    try {
                      setErr(null);
                      await savePanelImage(await shrinkImage(f));
                    } catch (ex) {
                      setErr((ex as Error).message);
                    }
                  }}
                />
                <span class="btn">{image ? 'Change image' : 'Upload image'}</span>
              </label>
              {image && <button onClick={() => void savePanelImage(null)}>Remove image</button>}
            </div>
            <p class="muted" style={{ margin: 0 }}>A new image applies at once.</p>
          </div>
        </div>
        {image && (
          <Row title="Image opacity" hint={pct(s.ui.panelImageOpacity)}>
            <input type="range" min="0" max="1" step="0.05" value={s.ui.panelImageOpacity} onInput={(e) => ui({ panelImageOpacity: num(e) })} />
          </Row>
        )}
      </Section>

      <Section title="On the page">
        <Row title="Start collapsed" hint="Open the panel with the Quickdraw button when you need it">
          {toggle(s.ui.startCollapsed, (startCollapsed) => ui({ startCollapsed }))}
        </Row>
        <Row title="Stacking" hint="Whether the site's menus and pop-ups can cover the panel">
          <select value={s.ui.layer} onChange={(e) => ui({ layer: value<Ui['layer']>(e) })}>
            <option value="below-popups">Below the site's pop-ups</option>
            <option value="above-popups">Above the site's pop-ups</option>
            <option value="top">Always on top</option>
          </select>
        </Row>
      </Section>

      <div class="row" style={{ marginTop: 16 }}>
        <button class="primary" onClick={() => void save()}>
          Save settings
        </button>
      </div>
      {status}
    </>
  );
}
