import * as React from "react"
import { cn } from "../../lib/utils"
import { X } from "lucide-react"

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

function Dialog({ open, onOpenChange, children }: DialogProps) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => onOpenChange(false)} />
      <div className="relative z-50 w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-xl border bg-background shadow-lg">
        {children}
      </div>
    </div>
  )
}

function DialogHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-start justify-between p-5 pb-3", className)} {...props}>{children}</div>
}

function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />
}

function DialogClose({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100">
      <X className="h-4 w-4" />
      <span className="sr-only">Close</span>
    </button>
  )
}

function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-4", className)} {...props} />
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-2 px-5 py-4 border-t", className)} {...props} />
}

export { Dialog, DialogHeader, DialogTitle, DialogClose, DialogBody, DialogFooter }
