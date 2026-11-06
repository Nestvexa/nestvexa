// React fixture for tests/ui-adapters.test.ts (no JSX: bundled as is).
import { createElement as h, useRef, useState } from 'react';
import {
  DataTable,
  DatePicker,
  Dialog,
  DialogTrigger,
  Menu,
  SelectAll,
  SelectRow,
  TableFilter,
  TableSearch,
  Tabs,
  ToastRegion,
} from '@nestvexa/ui/react';
import { categories, menuItems, products, tabs } from './data.mjs';

function Kit() {
  const toasts = useRef(null);
  const [closed, setClosed] = useState(0);
  const [selected, setSelected] = useState([]);
  const [date, setDate] = useState('');
  return h(
    'div',
    { id: 'kit' },
    h('h1', null, 'UI kit'),
    h(DialogTrigger, { target: 'kit-dialog', label: 'Open dialog' }),
    h('p', { id: 'dialog-log' }, `Closed ${closed}`),
    h(Tabs, {
      id: 'kit-tabs',
      label: 'Sections',
      tabs: tabs.map((tab) => ({
        ...tab,
        content: h('p', null, `${tab.label} panel`),
      })),
    }),
    h(Menu, {
      id: 'kit-menu',
      label: 'Actions',
      items: menuItems,
      onSelect: (value) => setSelected((list) => [...list, value]),
    }),
    h('p', { id: 'menu-log' }, selected.join(',')),
    h(
      'button',
      {
        type: 'button',
        id: 'notify',
        className: 'nv-button',
        onClick: () => toasts.current?.show('Saved'),
      },
      'Notify',
    ),
    h(ToastRegion, {
      id: 'kit-toasts',
      label: 'Notifications',
      dismissLabel: 'Dismiss',
      ref: toasts,
    }),
    h(DatePicker, {
      id: 'kit-due',
      name: 'due',
      label: 'Due date',
      locale: 'en-US',
      defaultValue: '2026-03-04',
      onChange: setDate,
    }),
    h('p', { id: 'date-log' }, date),
    h(
      'form',
      { id: 'bulk' },
      h(TableSearch, {
        table: 'kit-table',
        label: 'Search products',
        client: true,
        resultsLabel: '{count} results',
      }),
      h(TableFilter, {
        table: 'kit-table',
        field: 'category',
        label: 'Category',
        allLabel: 'All categories',
        options: categories,
        client: true,
        resultsLabel: '{count} results',
      }),
      h(
        DataTable,
        {
          id: 'kit-table',
          caption: 'Products',
          selectionLabel: '{count} selected',
        },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h(SelectAll, { table: 'kit-table', label: 'Select all products' }),
            h('th', { scope: 'col' }, 'Name'),
            h('th', { scope: 'col' }, 'Category'),
          ),
        ),
        h(
          'tbody',
          null,
          products.map((product) =>
            h(
              'tr',
              { key: product.id, 'data-category': product.category },
              h(SelectRow, {
                name: 'ids',
                value: product.id,
                label: `Select ${product.name}`,
              }),
              h('td', null, product.name),
              h('td', null, product.category),
            ),
          ),
        ),
      ),
    ),
    h(
      Dialog,
      {
        id: 'kit-dialog',
        title: 'Edit item',
        closeLabel: 'Close dialog',
        onClose: () => setClosed((count) => count + 1),
      },
      h('label', { htmlFor: 'kit-name' }, 'Name'),
      h('input', { id: 'kit-name' }),
    ),
  );
}

export function App() {
  const [shown, setShown] = useState(true);
  return h(
    'div',
    { id: 'shell' },
    h(
      'button',
      {
        type: 'button',
        id: 'toggle',
        className: 'nv-button',
        onClick: () => setShown((value) => !value),
      },
      'Toggle kit',
    ),
    shown ? h(Kit) : null,
  );
}
