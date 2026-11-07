// React fixture for tests/ui-adapters.test.ts (no JSX: bundled as is).
import { createElement as h, useRef, useState } from 'react';
import {
  Chart,
  CheckboxField,
  DataTable,
  DatePicker,
  Dialog,
  DialogTrigger,
  Menu,
  RadioGroupField,
  SelectAll,
  SelectField,
  SelectRow,
  TableFilter,
  TableSearch,
  Tabs,
  TextField,
  TextareaField,
  ToastRegion,
} from '@nestvexa/ui/react';
import {
  categories,
  countries,
  menuItems,
  months,
  plans,
  products,
  sales,
  tabs,
  visitors,
} from './data.mjs';

function Kit() {
  const toasts = useRef(null);
  const [closed, setClosed] = useState(0);
  const [selected, setSelected] = useState([]);
  const [date, setDate] = useState('');
  const [log, setLog] = useState('');
  const report = (name) => (value) => setLog(`${name}:${value}`);
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
    h(
      'form',
      { id: 'kit-profile' },
      h(TextField, {
        id: 'kit-email',
        name: 'email',
        label: 'Email',
        type: 'email',
        hint: 'We never share it.',
        error: 'Enter a valid email address.',
        required: true,
        autocomplete: 'email',
        onChange: report('email'),
      }),
      h(TextField, {
        id: 'kit-nick',
        name: 'nickname',
        label: 'Nickname',
        defaultValue: 'Ada',
      }),
      h(TextareaField, {
        id: 'kit-bio',
        name: 'bio',
        label: 'Biography',
        rows: 3,
        defaultValue: 'Hello',
        onChange: report('bio'),
      }),
      h(SelectField, {
        id: 'kit-country',
        name: 'country',
        label: 'Country',
        options: countries,
        placeholder: 'Choose a country',
        required: true,
        onChange: report('country'),
      }),
      h(CheckboxField, {
        id: 'kit-terms',
        name: 'terms',
        label: 'I accept the terms',
        value: 'yes',
        error: 'You must accept the terms.',
        onChange: report('terms'),
      }),
      h(RadioGroupField, {
        id: 'kit-plan',
        name: 'plan',
        label: 'Plan',
        options: plans,
        hint: 'Change it later.',
        defaultValue: 'basic',
        onChange: report('plan'),
      }),
    ),
    h('p', { id: 'field-log' }, log),
    h(
      'div',
      { id: 'kit-charts' },
      h(Chart, {
        id: 'kit-sales',
        title: 'Monthly sales',
        description: 'Online sales peaked in March.',
        categoryLabel: 'Month',
        labels: months,
        series: sales,
        locale: 'en-US',
      }),
      h(Chart, {
        id: 'kit-trend',
        type: 'line',
        title: 'Visitors',
        categoryLabel: 'Month',
        labels: months,
        series: visitors,
        showTable: true,
      }),
      h(Chart, {
        id: 'kit-spark',
        type: 'sparkline',
        title: 'Weekly visitors',
        categoryLabel: 'Month',
        labels: months,
        series: visitors,
      }),
      h(
        Chart,
        {
          id: 'kit-ext',
          type: 'custom',
          title: 'Third-party visits',
          categoryLabel: 'Month',
          labels: months,
          series: visitors,
        },
        h('canvas', { id: 'kit-ext-chart', width: '320', height: '120' }),
      ),
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
