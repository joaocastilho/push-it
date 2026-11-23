import { createElement, type IconNode } from 'lucide';

interface LucideIconProps {
  icon: IconNode;
  size?: number;
  strokeWidth?: number;
  class?: string;
}

export function LucideIcon(props: LucideIconProps) {
  return createElement(props.icon, {
    width: props.size ?? 14,
    height: props.size ?? 14,
    'stroke-width': props.strokeWidth ?? 2,
    class: props.class ?? '',
    'aria-hidden': 'true',
  });
}
