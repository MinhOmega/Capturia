import type { Editor } from "@tiptap/react";
import { Bold, Code, Italic, List, ListOrdered, Quote, Strikethrough } from "lucide-react";
import { type ReactNode, useEffect, useReducer } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

type NotesToolbarProps = {
  editor: Editor | null;
};

type ToolbarButtonProps = {
  "aria-label": string;
  tooltipContent: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
};

function ToolbarButton({
  "aria-label": ariaLabel,
  tooltipContent,
  active = false,
  disabled = false,
  onClick,
  children,
}: ToolbarButtonProps) {
  return (
    <Tooltip content={tooltipContent}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-md border-0 bg-transparent text-gray-700 transition-colors hover:bg-gray-200 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-35",
          active && "bg-gray-900 text-white hover:bg-gray-800 hover:text-white",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Re-render the toolbar on selection/transaction so `isActive` reflects the caret. */
function useEditorRevision(editor: Editor | null): void {
  const [, bumpRevision] = useReducer((revision: number) => revision + 1, 0);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const handleUpdate = () => {
      bumpRevision();
    };

    editor.on("selectionUpdate", handleUpdate);
    editor.on("transaction", handleUpdate);

    return () => {
      editor.off("selectionUpdate", handleUpdate);
      editor.off("transaction", handleUpdate);
    };
  }, [editor]);
}

export function NotesToolbar({ editor }: NotesToolbarProps) {
  useEditorRevision(editor);
  const { t } = useI18n();

  return (
    <div className="flex items-center gap-1 rounded-[0.625rem] max-w-fit border border-gray-200 bg-gray-50 p-1.5 overflow-x-auto">
      <div className="flex items-center justify-between flex-1 shrink-0 gap-1">
        <ToolbarButton
          aria-label={t("launch.tooltips.notesToolbar.bold")}
          tooltipContent={t("launch.tooltips.notesToolbar.bold")}
          active={editor?.isActive("bold") ?? false}
          disabled={!editor?.can().chain().focus().toggleBold().run()}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold size={16} />
        </ToolbarButton>
        <ToolbarButton
          aria-label={t("launch.tooltips.notesToolbar.italic")}
          tooltipContent={t("launch.tooltips.notesToolbar.italic")}
          active={editor?.isActive("italic") ?? false}
          disabled={!editor?.can().chain().focus().toggleItalic().run()}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic size={16} />
        </ToolbarButton>
        <ToolbarButton
          aria-label={t("launch.tooltips.notesToolbar.strikethrough")}
          tooltipContent={t("launch.tooltips.notesToolbar.strikethrough")}
          active={editor?.isActive("strike") ?? false}
          disabled={!editor?.can().chain().focus().toggleStrike().run()}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        >
          <Strikethrough size={16} />
        </ToolbarButton>
      </div>
      <div className="flex items-center justify-between flex-1 shrink-0 gap-1">
        <div className="h-8 w-5 grid place-content-center">
          <span className="mx-0.5 h-5 w-px bg-gray-300" aria-hidden="true" />
        </div>
        <ToolbarButton
          aria-label={t("launch.tooltips.notesToolbar.bulletList")}
          tooltipContent={t("launch.tooltips.notesToolbar.bulletList")}
          active={editor?.isActive("bulletList") ?? false}
          disabled={!editor?.can().chain().focus().toggleBulletList().run()}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List size={16} />
        </ToolbarButton>
        <ToolbarButton
          aria-label={t("launch.tooltips.notesToolbar.numberedList")}
          tooltipContent={t("launch.tooltips.notesToolbar.numberedList")}
          active={editor?.isActive("orderedList") ?? false}
          disabled={!editor?.can().chain().focus().toggleOrderedList().run()}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={16} />
        </ToolbarButton>
      </div>
      <div className="flex items-center justify-between flex-1 shrink-0 gap-1">
        <div className="h-8 w-5 grid place-content-center">
          <span className="mx-0.5 h-5 w-px bg-gray-300" aria-hidden="true" />
        </div>
        <ToolbarButton
          aria-label={t("launch.tooltips.notesToolbar.blockquote")}
          tooltipContent={t("launch.tooltips.notesToolbar.blockquote")}
          active={editor?.isActive("blockquote") ?? false}
          disabled={!editor?.can().chain().focus().toggleBlockquote().run()}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          <Quote size={16} />
        </ToolbarButton>
        <ToolbarButton
          aria-label={t("launch.tooltips.notesToolbar.codeBlock")}
          tooltipContent={t("launch.tooltips.notesToolbar.codeBlock")}
          active={editor?.isActive("codeBlock") ?? false}
          disabled={!editor?.can().chain().focus().toggleCodeBlock().run()}
          onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
        >
          <Code size={16} />
        </ToolbarButton>
      </div>
    </div>
  );
}
