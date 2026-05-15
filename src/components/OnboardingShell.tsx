import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useDragRegion } from '../hooks/useDragRegion'

interface OnboardingShellProps {
  children: ReactNode
  className?: string
  contentClassName?: string
  contentStyle?: CSSProperties
  style?: CSSProperties
  testId?: string
}

export function OnboardingShell({
  children,
  className,
  contentClassName,
  contentStyle,
  style,
  testId,
}: OnboardingShellProps) {
  const { onMouseDown } = useDragRegion()

  return (
    <div
      className={cn('flex h-full w-full items-center justify-center px-6 py-8', className)}
      style={style}
      data-testid={testId}
      onMouseDown={onMouseDown}
    >
      <div className={contentClassName} style={contentStyle} data-no-drag>
        {children}
      </div>
    </div>
  )
}
