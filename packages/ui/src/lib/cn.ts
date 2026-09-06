import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The shadcn/ui class helper.
 *
 * `clsx` flattens conditionals and arrays into a class string; `twMerge` then
 * resolves Tailwind conflicts by last-one-wins, so a caller's `px-8` overrides
 * a variant's `px-4` instead of both landing in the DOM and letting CSS source
 * order decide. That is what makes `className` a reliable override point on
 * every component in this package.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
