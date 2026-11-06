// Vue fixture for tests/ui-adapters.test.ts (render functions, no SFC).
import { defineComponent, h, ref } from 'vue';
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
} from '@nestvexa/ui/vue';
import { categories, menuItems, products, tabs } from './data.mjs';

const Kit = defineComponent({
  setup() {
    const toasts = ref(null);
    const closed = ref(0);
    const selected = ref([]);
    const date = ref('');
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
