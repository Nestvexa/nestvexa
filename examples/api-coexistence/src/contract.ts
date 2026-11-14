/** Shared demonstration API key; real hosts use their own authentication. */
export const API_KEY = 'coexistence-demo-key';

export interface Item {
  readonly id: string;
  readonly name: string;
}
