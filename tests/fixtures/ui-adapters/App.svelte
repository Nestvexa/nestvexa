<!-- Svelte fixture for tests/ui-adapters.test.ts. -->
<script>
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
  } from '@nestvexa/ui/svelte';
  import { categories, countries, menuItems, months, plans, products, sales, tabs, visitors } from './data.mjs';

  let shown = $state(true);
  let toasts = $state();
  let closed = $state(0);
  let selected = $state([]);
  let date = $state('');
  let log = $state('');
  const report = (name) => (value) => (log = `${name}:${value}`);
</script>

<div id="shell">
  <button type="button" id="toggle" class="nv-button" onclick={() => (shown = !shown)}>Toggle kit</button>
  {#if shown}
    <div id="kit">
      <h1>UI kit</h1>
      <DialogTrigger target="kit-dialog" label="Open dialog" />
      <p id="dialog-log">Closed {closed}</p>
      <Tabs id="kit-tabs" label="Sections" {tabs}>
        {#snippet panel(tab)}<p>{tab.label} panel</p>{/snippet}
      </Tabs>
      <Menu id="kit-menu" label="Actions" items={menuItems} onselect={(value) => (selected = [...selected, value])} />
      <p id="menu-log">{selected.join(',')}</p>
      <button type="button" id="notify" class="nv-button" onclick={() => toasts?.show('Saved')}>Notify</button>
      <ToastRegion id="kit-toasts" label="Notifications" dismissLabel="Dismiss" bind:this={toasts} />
      <DatePicker id="kit-due" name="due" label="Due date" locale="en-US" defaultValue="2026-03-04" onchange={(value) => (date = value)} />
      <p id="date-log">{date}</p>
      <form id="bulk">
        <TableSearch table="kit-table" label="Search products" client={true} resultsLabel={'{count} results'} />
        <TableFilter table="kit-table" field="category" label="Category" allLabel="All categories" options={categories} client={true} resultsLabel={'{count} results'} />
        <DataTable id="kit-table" caption="Products" selectionLabel={'{count} selected'}>
          <thead>
            <tr>
              <SelectAll table="kit-table" label="Select all products" />
              <th scope="col">Name</th>
              <th scope="col">Category</th>
            </tr>
          </thead>
          <tbody>
            {#each products as product (product.id)}
              <tr data-category={product.category}>
                <SelectRow name="ids" value={product.id} label={`Select ${product.name}`} />
                <td>{product.name}</td>
                <td>{product.category}</td>
              </tr>
            {/each}
          </tbody>
        </DataTable>
      </form>
      <Dialog id="kit-dialog" title="Edit item" closeLabel="Close dialog" onclose={() => (closed += 1)}>
        <label for="kit-name">Name</label><input id="kit-name" />
      </Dialog>
      <form id="kit-profile">
        <TextField id="kit-email" name="email" label="Email" type="email" hint="We never share it." error="Enter a valid email address." required={true} autocomplete="email" onchange={report('email')} />
        <TextField id="kit-nick" name="nickname" label="Nickname" defaultValue="Ada" />
        <TextareaField id="kit-bio" name="bio" label="Biography" rows={3} defaultValue="Hello" onchange={report('bio')} />
        <SelectField id="kit-country" name="country" label="Country" options={countries} placeholder="Choose a country" required={true} onchange={report('country')} />
        <CheckboxField id="kit-terms" name="terms" label="I accept the terms" value="yes" error="You must accept the terms." onchange={report('terms')} />
        <RadioGroupField id="kit-plan" name="plan" label="Plan" options={plans} hint="Change it later." defaultValue="basic" onchange={report('plan')} />
      </form>
      <p id="field-log">{log}</p>
      <div id="kit-charts">
        <Chart id="kit-sales" title="Monthly sales" description="Online sales peaked in March." categoryLabel="Month" labels={months} series={sales} locale="en-US" />
        <Chart id="kit-trend" type="line" title="Visitors" categoryLabel="Month" labels={months} series={visitors} showTable={true} />
        <Chart id="kit-spark" type="sparkline" title="Weekly visitors" categoryLabel="Month" labels={months} series={visitors} />
        <Chart id="kit-ext" type="custom" title="Third-party visits" categoryLabel="Month" labels={months} series={visitors}>
          <canvas id="kit-ext-chart" width="320" height="120"></canvas>
        </Chart>
      </div>
    </div>
  {/if}
</div>
