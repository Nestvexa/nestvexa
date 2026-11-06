// Progressive enhancement for the HBS/Live page, loaded through the Vite
// manifest by the `viteTags` view helper (CSS, modulepreload and this entry,
// all nonce-bound). It never touches Live-owned markup.
import { markEnhanced } from './shared';
import './live.css';

markEnhanced('live-assets');
