import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-colors duration-200 ease-out outline-none select-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-[var(--brand)] text-white hover:bg-[var(--brand-hover)]',
        outline:
          'border-[var(--border)] bg-white text-[var(--foreground)] hover:bg-[var(--secondary)]',
        secondary:
          'bg-[var(--secondary)] text-[var(--foreground)] hover:bg-[#E9E6DF]',
        ghost:
          'text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
        destructive:
          'bg-red-50 text-[var(--destructive)] hover:bg-red-100',
        link: 'text-[var(--brand-strong)] underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 gap-2 px-4',
        xs: "h-7 gap-1 rounded-md px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 text-[0.8rem] [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-11 gap-2 px-5',
        icon: 'size-10',
        'icon-xs': "size-7 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8 rounded-md',
        'icon-lg': 'size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }