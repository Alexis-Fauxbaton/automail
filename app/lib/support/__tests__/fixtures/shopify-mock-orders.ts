/**
 * Mock Shopify order data for use in pipeline tests.
 * Represents what the Shopify Admin API would return for test scenarios.
 */

import type { OrderSearchResult, RawOrderNode } from "../../shopify/order-search";

/** A fully fulfilled order with tracking — best case. */
export const RAW_ORDER_FULFILLED: RawOrderNode = {
  id: "gid://shopify/Order/1001",
  name: "#1001",
  createdAt: "2024-01-10T10:00:00Z",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "FULFILLED",
  customer: {
    firstName: "Sarah",
    lastName: "Johnson",
    email: "sarah@example.com",
  },
  lineItems: {
    edges: [{ node: { title: "Blue T-Shirt", quantity: 1 } }],
  },
  fulfillments: [
    {
      id: "gid://shopify/Fulfillment/1",
      status: "SUCCESS",
      updatedAt: "2024-01-11T08:00:00Z",
      estimatedDeliveryAt: "2024-01-15T00:00:00Z",
      trackingInfo: [
        {
          company: "La Poste",
          number: "6123456789012",
          url: "https://www.laposte.fr/outils/suivre-vos-envois?code=6123456789012",
        },
      ],
      fulfillmentLineItems: {
        edges: [
          {
            node: {
              lineItem: { title: "Blue T-Shirt", quantity: 1 },
              quantity: 1,
            },
          },
        ],
      },
    },
  ],
};

/** An order that has been paid but not yet shipped. */
export const RAW_ORDER_UNFULFILLED: RawOrderNode = {
  id: "gid://shopify/Order/2002",
  name: "#2002",
  createdAt: "2024-01-12T14:00:00Z",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "UNFULFILLED",
  customer: {
    firstName: "Marie",
    lastName: "Dupont",
    email: "marie@example.com",
  },
  lineItems: {
    edges: [{ node: { title: "Ceramic Mug", quantity: 2 } }],
  },
  fulfillments: [],
};

/** An order with a tracking number but the carrier is not set (inferred). */
export const RAW_ORDER_INFERRED_CARRIER: RawOrderNode = {
  id: "gid://shopify/Order/6006",
  name: "#6006",
  createdAt: "2024-01-05T09:00:00Z",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "IN_TRANSIT",
  customer: {
    firstName: "Paul",
    lastName: null,
    email: "paul@example.com",
  },
  lineItems: {
    edges: [{ node: { title: "Running Shoes", quantity: 1 } }],
  },
  fulfillments: [
    {
      id: "gid://shopify/Fulfillment/6",
      status: "IN_TRANSIT",
      updatedAt: "2024-01-06T10:00:00Z",
      estimatedDeliveryAt: null,
      trackingInfo: [
        {
          company: null,       // No carrier set — will be inferred
          number: "6123456789012",
          url: null,
        },
      ],
      fulfillmentLineItems: { edges: [] },
    },
  ],
};

/** Two orders matching the same customer name — ambiguous case. */
export const RAW_ORDERS_AMBIGUOUS: RawOrderNode[] = [
  {
    id: "gid://shopify/Order/9001",
    name: "#9001",
    createdAt: "2024-01-08T10:00:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    customer: { firstName: "John", lastName: "Smith", email: "j.smith@a.com" },
    lineItems: { edges: [{ node: { title: "Product A", quantity: 1 } }] },
    fulfillments: [],
  },
  {
    id: "gid://shopify/Order/9002",
    name: "#9002",
    createdAt: "2024-01-09T10:00:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    customer: { firstName: "John", lastName: "Smith", email: "j.smith@b.com" },
    lineItems: { edges: [{ node: { title: "Product B", quantity: 1 } }] },
    fulfillments: [],
  },
];

// Prebuilt OrderSearchResult shapes for easy use in test mocks

export const SEARCH_RESULT_FULFILLED: OrderSearchResult = {
  matchedBy: "orderNumber",
  orders: [RAW_ORDER_FULFILLED],
};

export const SEARCH_RESULT_UNFULFILLED: OrderSearchResult = {
  matchedBy: "orderNumber",
  orders: [RAW_ORDER_UNFULFILLED],
};

export const SEARCH_RESULT_INFERRED_CARRIER: OrderSearchResult = {
  matchedBy: "orderNumber",
  orders: [RAW_ORDER_INFERRED_CARRIER],
};

export const SEARCH_RESULT_AMBIGUOUS: OrderSearchResult = {
  matchedBy: "customerName",
  orders: RAW_ORDERS_AMBIGUOUS,
};

export const SEARCH_RESULT_EMPTY: OrderSearchResult = {
  matchedBy: null,
  orders: [],
};
