import { Head } from '@inertiajs/react';
import '@nestvexa/ui/theme.css';
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
import type { ToastHandle } from '@nestvexa/ui/react';
import { useRef, useState } from 'react';

interface KitProduct {
  readonly id: string;
  readonly name: string;
  readonly category: 'books' | 'tools';
}

const initialDue = '2026-03-04';

// The @nestvexa/ui primitives through the React wrappers: same markup as the
// HBS helpers, behavior from @nestvexa/ui/browser (focus trap, roving tabs,
// menu keys, toasts, date formatting, client filtering and selection).
export default function KitIndex({
  products,
}: {
  readonly products: readonly KitProduct[];
}) {
  const toasts = useRef<ToastHandle>(null);
  const [log, setLog] = useState<readonly string[]>([]);
  // The wrappers are uncontrolled: defaultValue is read once, so it stays a
  // constant and the change callback only mirrors the value.
  const [due, setDue] = useState(initialDue);
  const record = (entry: string) => setLog((entries) => [...entries, entry]);
  return (
    <>
      <Head title="UI kit" />
      <h1>UI kit</h1>
      <DialogTrigger target="kit-dialog" label="Open dialog" />
      <Tabs
        id="kit-tabs"
        label="Sections"
        tabs={[
          { id: 'overview', label: 'Overview', content: <p>Overview panel</p> },
          { id: 'details', label: 'Details', content: <p>Details panel</p> },
          { id: 'history', label: 'History', content: <p>History panel</p> },
        ]}
      />
      <Menu
        id="kit-menu"
        label="Actions"
        items={[
          { label: 'Copy id', value: 'copy' },
          { label: 'Archive', value: 'archive' },
          { label: 'Delete', value: 'delete', disabled: true },
        ]}
        onSelect={(value) => record(`menu:${value}`)}
      />
      <button
        type="button"
        className="nv-button"
        onClick={() => toasts.current?.show('Saved')}
      >
        Notify
      </button>
      <ToastRegion
        id="kit-toasts"
        label="Notifications"
        dismissLabel="Dismiss"
        ref={toasts}
      />
      <DatePicker
        id="kit-due"
        name="due"
        label="Due date"
        locale="en-US"
        defaultValue={initialDue}
        onChange={setDue}
      />
      <p data-testid="kit-due">{due}</p>
      <TableSearch
        table="kit-table"
        label="Search products"
        client
        resultsLabel="{count} results"
      />
      <TableFilter
        table="kit-table"
        field="category"
        label="Category"
        allLabel="All categories"
        options={[
          { value: 'books', label: 'Books' },
          { value: 'tools', label: 'Tools' },
        ]}
        client
        resultsLabel="{count} results"
      />
      <DataTable
        id="kit-table"
        caption="Products"
        selectionLabel="{count} selected"
      >
        <thead>
          <tr>
            <SelectAll table="kit-table" label="Select all products" />
            <th scope="col">Name</th>
            <th scope="col">Category</th>
          </tr>
        </thead>
        <tbody>
          {products.map((product) => (
            <tr key={product.id} data-category={product.category}>
              <SelectRow
                name="ids"
                value={product.id}
                label={`Select ${product.name}`}
              />
              <td>{product.name}</td>
              <td>{product.category}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <p data-testid="kit-log">{log.join(',')}</p>
      <Dialog
        id="kit-dialog"
        title="Edit item"
        closeLabel="Close dialog"
        onClose={() => record('dialog:closed')}
      >
        <label htmlFor="kit-name">Name</label>
        <input id="kit-name" />
      </Dialog>
    </>
  );
}
