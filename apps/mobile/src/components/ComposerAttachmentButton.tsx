import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { SymbolView } from "./AppSymbol";
import { ControlPillMenu } from "./ControlPill";

const ATTACHMENT_MENU_ACTIONS: MenuAction[] = [
  { id: "photos", title: "Photo Library", image: "photo" },
  { id: "files", title: "Choose Files", image: "folder" },
];

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly supportsFiles: boolean;
  /**
   * Whether the selected provider can consume images in a prompt. Absent means
   * yes. Some agents advertise image prompts and then drop every non-text
   * block, so offering the picker would collect a photo that never arrives.
   */
  readonly supportsImages?: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
}) {
  const supportsImages = props.supportsImages !== false;
  const actions = ATTACHMENT_MENU_ACTIONS.filter(
    (action) => supportsImages || action.id !== "photos",
  );
  const button = (
    <Pressable
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
      onPress={actions.length > 1 ? undefined : () => void props.onPickMedia()}
    >
      <SymbolView
        name="plus"
        size={20}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  // A single remaining action does not need a menu, and no actions at all
  // means the provider cannot take anything this composer can produce.
  if (props.disabled || actions.length <= 1) {
    return actions.length === 0 ? null : button;
  }

  return (
    <ControlPillMenu
      accessible
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "photos") {
          void props.onPickMedia();
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        }
      }}
    >
      {button}
    </ControlPillMenu>
  );
}
