// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Non-modal anchored popover primitives, skinned with Ink Carbon tokens. */
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { type ComponentProps, forwardRef, useId } from "react";
import "./components.css";

const IcPopover = PopoverPrimitive.Root;
const IcPopoverClose = PopoverPrimitive.Close;
const IcPopoverTrigger = PopoverPrimitive.Trigger;

type IcPopoverPopupProps = Omit<ComponentProps<typeof PopoverPrimitive.Popup>, "role">;

// A popover is an interactive disclosure, unlike a passive tooltip. Keep the
// shared primitive's dialog semantics intact so triggers and popups agree.
const IcPopoverPopup = forwardRef<HTMLDivElement, IcPopoverPopupProps>(
  ({ className, id, ...props }, ref) => {
    const generatedId = useId();
    return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner side="bottom" sideOffset={6}>
        <PopoverPrimitive.Popup
          className={["pdpp-popover", className].filter(Boolean).join(" ")}
          ref={ref}
          id={id ?? generatedId}
          {...props}
          role="dialog"
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
    );
  }
);
IcPopoverPopup.displayName = "IcPopoverPopup";

export { IcPopover, IcPopoverClose, IcPopoverPopup, IcPopoverTrigger };
