// The Display tab: how the panel looks (theme, colours, layout, size, layer)
// and what it shows.
import { useEffect, useState } from 'preact/hooks';
import type { WalletState } from '../../messages';
import type { Settings } from '../../settings/schema';
import { useSettingsDraft } from './settingsDraft';
import { savePanelImage, shrinkImage, watchPanelImage } from '../panelImage';
import { playResult } from '../sounds';

export function DisplayTab({ state, refresh }: { state: WalletState; refresh(): void }) {
  const { s, setS, save, status, setErr } = useSettingsDraft(state, refresh);
  // The background image is stored on its own, as soon as it's chosen (its opacity saves with the settings).
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => watchPanelImage(setImage), []);
  const num = (e: Event) => Number((e.target as HTMLInputElement).value);
  const checked = (e: Event) => (e.target as HTMLInputElement).checked;

  return (
    <>
      <div class="card grid2">
        <label>
          Theme
          <select value={s.ui.theme} onChange={(e) => setS({ ...s, ui: { ...s.ui, theme: (e.target as HTMLSelectElement).value as Settings['ui']['theme'] } })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="auto">Auto</option>
          </select>
        </label>
        <label>
          Accent
          <input type="color" value={s.ui.accent} onChange={(e) => setS({ ...s, ui: { ...s.ui, accent: (e.target as HTMLInputElement).value } })} />
        </label>
        <label>
          Panel background
          <span class="row" style={{ gap: 8 }}>
            <input type="color" value={s.ui.panelBg ?? '#1c1c1c'} onChange={(e) => setS({ ...s, ui: { ...s.ui, panelBg: (e.target as HTMLInputElement).value } })} />
            {s.ui.panelBg ? <button onClick={() => setS({ ...s, ui: { ...s.ui, panelBg: null } })}>Use theme</button> : <span class="muted">Follows the theme</span>}
          </span>
        </label>
        <label>
          Layout
          <select value={s.ui.layout} onChange={(e) => setS({ ...s, ui: { ...s.ui, layout: (e.target as HTMLSelectElement).value as Settings['ui']['layout'] } })}>
            <option value="full">Full</option>
            <option value="compact">Compact</option>
          </select>
        </label>
        <label>
          Opacity
          <input type="range" min="0.5" max="1" step="0.05" value={s.ui.opacity} onChange={(e) => setS({ ...s, ui: { ...s.ui, opacity: num(e) } })} />
        </label>
        <label>
          Scale
          <input type="range" min="0.6" max="1.6" step="0.05" value={s.ui.scale} onChange={(e) => setS({ ...s, ui: { ...s.ui, scale: num(e) } })} />
        </label>
        <label>
          Buy rows
          <select value={s.ui.rows.buy} onChange={(e) => setS({ ...s, ui: { ...s.ui, rows: { ...s.ui.rows, buy: num(e) } } })}>
            <option value={1}>1 row</option>
            <option value={2}>2 rows</option>
            <option value={3}>3 rows</option>
          </select>
        </label>
        <label>
          Sell rows
          <select value={s.ui.rows.sell} onChange={(e) => setS({ ...s, ui: { ...s.ui, rows: { ...s.ui.rows, sell: num(e) } } })}>
            <option value={1}>1 row</option>
            <option value={2}>2 rows</option>
            <option value={3}>3 rows</option>
          </select>
        </label>
        <label>
          Sell buttons
          <select value={s.ui.sellRows} onChange={(e) => setS({ ...s, ui: { ...s.ui, sellRows: (e.target as HTMLSelectElement).value as Settings['ui']['sellRows'] } })}>
            <option value="follow">Follow the Sell SOL / % switch</option>
            <option value="mixed">SOL amounts on the first row, % below</option>
            <option value="pct">Always percentages</option>
          </select>
        </label>
        <label>
          Button shape
          <select value={s.ui.buttonShape} onChange={(e) => setS({ ...s, ui: { ...s.ui, buttonShape: (e.target as HTMLSelectElement).value as Settings['ui']['buttonShape'] } })}>
            <option value="square">Square (joined strips)</option>
            <option value="rounded">Rounded (separate pills)</option>
          </select>
        </label>
        <label>
          Panel layer
          <select value={s.ui.layer} onChange={(e) => setS({ ...s, ui: { ...s.ui, layer: (e.target as HTMLSelectElement).value as Settings['ui']['layer'] } })}>
            <option value="below-popups">Below the site's pop-ups (tweet cards, menus)</option>
            <option value="above-popups">Above the site's pop-ups</option>
            <option value="top">Always on top</option>
          </select>
        </label>
        <label class="inline">
          <input type="checkbox" checked={s.ui.startCollapsed} onChange={(e) => setS({ ...s, ui: { ...s.ui, startCollapsed: checked(e) } })} />
          Start collapsed
        </label>
        <label class="inline">
          <input type="checkbox" checked={s.ui.show.pnl} onChange={(e) => setS({ ...s, ui: { ...s.ui, show: { ...s.ui.show, pnl: checked(e) } } })} />
          Show position / PnL line
        </label>
        <label class="inline">
          <input type="checkbox" checked={s.ui.show.currencySwitch} onChange={(e) => setS({ ...s, ui: { ...s.ui, show: { ...s.ui.show, currencySwitch: checked(e) } } })} />
          Show the SOL / % labels and the Sell switch
        </label>
        <label class="inline">
          <input type="checkbox" checked={s.ui.show.tokenAmounts} onChange={(e) => setS({ ...s, ui: { ...s.ui, show: { ...s.ui.show, tokenAmounts: checked(e) } } })} />
          Show your holdings in the sell header (tokens · USD · SOL)
        </label>
        <label class="inline">
          <input type="checkbox" checked={s.ui.show.venueBadge} onChange={(e) => setS({ ...s, ui: { ...s.ui, show: { ...s.ui.show, venueBadge: checked(e) } } })} />
          Show venue badge
        </label>
        <label class="inline">
          <input type="checkbox" checked={s.ui.show.feesSaved} onChange={(e) => setS({ ...s, ui: { ...s.ui, show: { ...s.ui.show, feesSaved: checked(e) } } })} />
          Show "Saved … vs a 1% platform fee"
        </label>
        <label class="inline">
          <input type="checkbox" checked={s.ui.show.tradeToasts} onChange={(e) => setS({ ...s, ui: { ...s.ui, show: { ...s.ui.show, tradeToasts: checked(e) } } })} />
          Show trade pop-ups (sending, sent, landed). Failures always show.
        </label>
        <label>
          Pop-up duration: {s.ui.toastSeconds}s
          <input type="range" min="1" max="30" step="1" value={s.ui.toastSeconds} onInput={(e) => setS({ ...s, ui: { ...s.ui, toastSeconds: num(e) } })} />
        </label>
        <label>
          Most pop-ups on screen: {s.ui.toastMax}
          <input type="range" min="1" max="4" step="1" value={s.ui.toastMax} onInput={(e) => setS({ ...s, ui: { ...s.ui, toastMax: num(e) } })} />
        </label>
        <label class="inline">
          <input type="checkbox" checked={s.ui.sound.enabled} onChange={(e) => setS({ ...s, ui: { ...s.ui, sound: { ...s.ui.sound, enabled: checked(e) } } })} />
          Sound when a trade lands or fails
        </label>
        {s.ui.sound.enabled && (
          <label>
            Sound volume ({Math.round(s.ui.sound.volume * 100)}%)
            <div class="row" style={{ alignItems: 'center', gap: 8 }}>
              <input type="range" min="0" max="1" step="0.05" value={s.ui.sound.volume} onInput={(e) => setS({ ...s, ui: { ...s.ui, sound: { ...s.ui.sound, volume: num(e) } } })} style={{ flex: 1 }} />
              <button type="button" onClick={() => playResult('landed', s.ui.sound.volume)}>Landed</button>
              <button type="button" onClick={() => playResult('failed', s.ui.sound.volume)}>Failed</button>
            </div>
          </label>
        )}
        <label>
          Pop-up position
          <select value={s.ui.toastPosition} onChange={(e) => setS({ ...s, ui: { ...s.ui, toastPosition: (e.target as HTMLSelectElement).value as Settings['ui']['toastPosition'] } })}>
            <option value="panel">Under the panel</option>
            <option value="top-left">Top left</option>
            <option value="top-center">Top middle</option>
            <option value="top-right">Top right</option>
            <option value="bottom-left">Bottom left</option>
            <option value="bottom-center">Bottom middle</option>
            <option value="bottom-right">Bottom right</option>
          </select>
        </label>
      </div>

      <h2>Background image</h2>
      <div class="card">
        <div class="row" style={{ alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 132,
              height: 132,
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
            <label>
              Image opacity ({Math.round(s.ui.panelImageOpacity * 100)}%)
              <input type="range" min="0" max="1" step="0.05" value={s.ui.panelImageOpacity} onInput={(e) => setS({ ...s, ui: { ...s.ui, panelImageOpacity: num(e) } })} />
            </label>
            <p class="muted" style={{ margin: 0 }}>
              Drawn over the panel colour, under the buttons. Stored only in this browser. A new image applies at once; save to keep the opacity.
            </p>
          </div>
        </div>
      </div>

      <div class="row" style={{ marginTop: 16 }}>
        <button class="primary" onClick={() => void save()}>
          Save settings
        </button>
      </div>
      {status}
    </>
  );
}
