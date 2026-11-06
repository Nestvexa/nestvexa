// Second entry of the Live asset build; sharing `markEnhanced` with app.ts
// forces a separate shared chunk.
import { markEnhanced } from './shared';

markEnhanced('widgets');
