var assert = require('node:assert/strict');
var test = require('node:test');
var pricing = require('../lib/pricing');
var invoice = require('../lib/invoice');
var orders = require('../lib/orders');
var reports = require('../lib/reports');

function saveOrder(items, coupon) {
  // Match the order route's persisted totals without opening the JSON store.
  var totals = pricing.computeTotals(items, coupon);
  return orders.add({ nextOrderId: 1, orders: [] }, {
    date: '01/02/2022',
    items: items,
    coupon: coupon,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  });
}

test('checkout apportions a coupon before applying mixed HSN GST slabs', function () {
  var items = [
    { id: 1, name: 'Rice', hsn: '1006', price: 150, qty: 2 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 200, qty: 1 }
  ];

  assert.deepEqual(pricing.computeTotals(items, 'SAVE10'), {
    subtotal: 500,
    discount: 50,
    taxable: 450,
    tax: 35.1,
    cgst: 17.55,
    sgst: 17.55,
    total: 485.1,
    lines: [
      { id: 1, name: 'Rice', hsn: '1006', gstPercent: 5, gross: 300,
        discount: 30, taxable: 270, tax: 13.5, net: 283.5 },
      { id: 2, name: 'Ghee', hsn: '0405', gstPercent: 12, gross: 200,
        discount: 20, taxable: 180, tax: 21.6, net: 201.6 }
    ]
  });
});

test('an undiscounted order with the default GST rate matches its invoice', function () {
  var order = saveOrder([{ name: 'Unclassified item', price: 100, qty: 1 }]);
  var figures = invoice.computeInvoiceFigures(order);
  var reconciliation = reports.getGstReconciliation({ orders: [order] });

  assert.equal(order.total, 118);
  assert.equal(figures.total, 118);
  assert.equal(figures.tax, 18);
  assert.equal(figures.cgst, 9);
  assert.equal(figures.sgst, 9);
  assert.equal(reconciliation.rows[0].matched, true);
  assert.equal(reconciliation.mismatchCount, 0);
});

test('a mixed-HSN order with SAVE10 matches its printable invoice and GST report', function () {
  var order = saveOrder([
    { name: 'Rice', hsn: '1006', price: 640, qty: 1 },
    { name: 'Butter', hsn: '0405', price: 260, qty: 1 }
  ], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(order);
  var reconciliation = reports.getGstReconciliation({ orders: [order] });
  var html = invoice.render(order);

  assert.deepEqual([order.discount, order.tax, order.total], [90, 56.88, 866.88]);
  assert.deepEqual([figures.discount, figures.tax, figures.total],
    [order.discount, order.tax, order.total]);
  assert.deepEqual(figures.rows.map(function (row) {
    return [row.gstPercent, row.lineTax];
  }), [[5, 28.8], [12, 28.08]]);
  assert.equal(reconciliation.rows[0].matched, true);
  assert.match(html, /Invoice Total<\/td><td class="r">₹866\.88/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice uses the GST slabs for HSN-only order lines', function () {
  var order = saveOrder([
    { name: 'Rice', hsn: '1006', price: 100, qty: 1 },
    { name: 'Ghee', hsn: '0405', price: 100, qty: 1 }
  ]);
  var figures = invoice.computeInvoiceFigures(order);
  var reconciliation = reports.getGstReconciliation({ orders: [order] });

  assert.equal(order.tax, 17);
  assert.equal(order.total, 217);
  assert.deepEqual(figures.rows.map(function (row) {
    return [row.hsn, row.gstPercent, row.lineTax];
  }), [['1006', 5, 5], ['0405', 12, 12]]);
  assert.equal(figures.tax, 17);
  assert.equal(figures.cgst, 8.5);
  assert.equal(figures.sgst, 8.5);
  assert.equal(figures.total, 217);
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(reconciliation.totalDelta, 0);
  assert.equal(reconciliation.rows[0].matched, true);
  assert.equal(reconciliation.rows[0].delta, 0);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice applies a flat coupon before GST', function () {
  var order = saveOrder([{ name: 'Tea', hsn: '0902', price: 400, qty: 1 }], 'FLAT50');
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [50, 63, 413]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 63, 413]);
});

test('invoice caps a percentage coupon and applies it before GST', function () {
  var order = saveOrder([{ name: 'Tea', hsn: '0902', price: 2000, qty: 1 }], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [150, 333, 2183]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [150, 333, 2183]);
});

test('a WELCOME order matches both tax and total in reconciliation', function () {
  var order = saveOrder([{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }], 'WELCOME');
  var figures = invoice.computeInvoiceFigures(order);
  var reconciliation = reports.getGstReconciliation({ orders: [order] });

  assert.deepEqual([order.tax, order.total], [17.1, 112.1]);
  assert.deepEqual([figures.tax, figures.total], [17.1, 112.1]);
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(reconciliation.totalDelta, 0);
  assert.equal(reconciliation.rows[0].matched, true);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice GST sums the individually rounded line taxes', function () {
  var order = saveOrder([
    { name: 'First item', price: 0.03, qty: 1 },
    { name: 'Second item', price: 0.03, qty: 1 }
  ]);
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.tax, order.total], [0.02, 0.08]);
  assert.deepEqual(figures.rows.map(function (row) { return row.lineTax; }), [0.01, 0.01]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [0.02, 0.01, 0.01, 0.08]);
});
