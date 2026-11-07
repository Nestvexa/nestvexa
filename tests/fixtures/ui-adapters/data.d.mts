export declare const tabs: readonly { id: string; label: string }[];
export declare const menuItems: readonly {
  label: string;
  href?: string;
  value?: string;
  disabled?: boolean;
}[];
export declare const categories: readonly { value: string; label: string }[];
export declare const products: readonly {
  id: string;
  name: string;
  category: string;
}[];
export declare const countries: readonly { value: string; label: string }[];
export declare const plans: readonly {
  value: string;
  label: string;
  disabled?: boolean;
}[];
export declare const months: readonly string[];
export declare const sales: readonly { name: string; values: number[] }[];
export declare const visitors: readonly { name: string; values: number[] }[];
