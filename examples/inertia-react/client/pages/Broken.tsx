import type { AppPages } from '../../src/page-types';

/** Throws during render: SSR falls back and the layout's error boundary takes over. */
export default function Broken({ reason }: AppPages['Broken']): never {
  throw new Error(reason);
}
