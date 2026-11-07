// Shared fixture data for the UI kit wrapper parity and behavior tests.
export const tabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'details', label: 'Details' },
  { id: 'history', label: 'History' },
];
export const menuItems = [
  { label: 'Edit', href: '/kit/edit' },
  { label: 'Copy id', value: 'copy' },
  { label: 'Archive', value: 'archive' },
  { label: 'Delete', value: 'delete', disabled: true },
];
export const categories = [
  { value: 'books', label: 'Books' },
  { value: 'tools', label: 'Tools' },
];
export const products = [
  { id: 'p1', name: 'Atlas', category: 'books' },
  { id: 'p2', name: 'Hammer', category: 'tools' },
  { id: 'p3', name: 'Almanac', category: 'books' },
];
export const countries = [
  { value: 'eg', label: 'Egypt' },
  { value: 'fr', label: 'France' },
];
export const plans = [
  { value: 'basic', label: 'Basic' },
  { value: 'pro', label: 'Pro' },
  { value: 'team', label: 'Team', disabled: true },
];
export const months = ['Jan', 'Feb', 'Mar'];
export const sales = [
  { name: 'Online', values: [1200, -300, 4500] },
  { name: 'Retail', values: [800, 900, 1000] },
];
export const visitors = [{ name: 'Visitors', values: [30, 10, 20] }];
