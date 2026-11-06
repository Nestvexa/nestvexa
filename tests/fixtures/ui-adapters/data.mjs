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
