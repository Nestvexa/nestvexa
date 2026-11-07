// Vue fixture for tests/ui-adapters.test.ts (render functions, no SFC).
import { defineComponent, h, ref } from 'vue';
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
} from '@nestvexa/ui/vue';
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

const Kit = defineComponent({
  setup() {
    const toasts = ref(null);
    const closed = ref(0);
    const selected = ref([]);
    const date = ref('');
    const log = ref('');
    const report = (name) => (value) => {
      log.value = `${name}:${value}`;
    };
    return () =>
      h('div', { id: 'kit' }, [
        h('h1', 'UI kit'),
        h(DialogTrigger, { target: 'kit-dialog', label: 'Open dialog' }),
        h('p', { id: 'dialog-log' }, `Closed ${closed.value}`),
        h(
          Tabs,
          { id: 'kit-tabs', label: 'Sections', tabs },
          Object.fromEntries(
            tabs.map((tab) => [
              `panel-${tab.id}`,
              () => h('p', `${tab.label} panel`),
            ]),
          ),
        ),
        h(Menu, {
          id: 'kit-menu',
          label: 'Actions',
          items: menuItems,
          onSelect: (value) => {
            selected.value = [...selected.value, value];
          },
        }),
        h('p', { id: 'menu-log' }, selected.value.join(',')),
        h(
          'button',
          {
            type: 'button',
            id: 'notify',
            class: 'nv-button',
            onClick: () => toasts.value?.show('Saved'),
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
          onChange: (value) => {
            date.value = value;
          },
        }),
        h('p', { id: 'date-log' }, date.value),
        h('form', { id: 'bulk' }, [
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
            () => [
              h('thead', [
                h('tr', [
                  h(SelectAll, {
                    table: 'kit-table',
                    label: 'Select all products',
                  }),
                  h('th', { scope: 'col' }, 'Name'),
                  h('th', { scope: 'col' }, 'Category'),
                ]),
              ]),
              h(
                'tbody',
                products.map((product) =>
                  h(
                    'tr',
                    { key: product.id, 'data-category': product.category },
                    [
                      h(SelectRow, {
                        name: 'ids',
                        value: product.id,
                        label: `Select ${product.name}`,
                      }),
                      h('td', product.name),
                      h('td', product.category),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ]),
        h(
          Dialog,
          {
            id: 'kit-dialog',
            title: 'Edit item',
            closeLabel: 'Close dialog',
            onClose: () => {
              closed.value += 1;
            },
          },
          () => [
            h('label', { for: 'kit-name' }, 'Name'),
            h('input', { id: 'kit-name' }),
          ],
        ),
        h('form', { id: 'kit-profile' }, [
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
        ]),
        h('p', { id: 'field-log' }, log.value),
        h('div', { id: 'kit-charts' }, [
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
            () => [
              h('canvas', { id: 'kit-ext-chart', width: '320', height: '120' }),
            ],
          ),
        ]),
      ]);
  },
});

export const App = defineComponent({
  setup() {
    const shown = ref(true);
    return () =>
      h('div', { id: 'shell' }, [
        h(
          'button',
          {
            type: 'button',
            id: 'toggle',
            class: 'nv-button',
            onClick: () => {
              shown.value = !shown.value;
            },
          },
          'Toggle kit',
        ),
        shown.value ? h(Kit) : null,
      ]);
  },
});
