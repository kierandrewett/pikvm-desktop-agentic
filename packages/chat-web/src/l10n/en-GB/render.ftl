# File renderers (components/render). File names, language names and file contents are data and are never translated.
# $name is a file name. $kind is a kind label such as "PDF document". $ext is an upper-case extension such as "PNG".
# $size is a file size already formatted for the locale ("1.2 MB").

## Shared states

render-download = Download
render-loading = Loading preview
render-error-title = Could not open { $name }
render-error-unreadable = { $kind } could not be read. The file may be damaged, or use a variant this preview does not support.
render-too-large-title = Too large to preview
render-too-large-body-size = At { $size }, this file is more than a preview can hold. Download it to open it in another app.
render-too-large-body = Download it to open it in another app.
render-empty-title = This file is empty
render-empty-body = { $name } has no content yet.

## File panel header (render/file-panel.tsx), shared by the Files page and the conversation side panel

render-panel-back = Back
render-panel-open-files = Open in Files
render-panel-open-chat = Open chat
render-panel-open-tab = Open in new tab

## Errors from the file download

render-error-size = This file is { $size }.
render-error-too-large = This file is too large.
render-error-gone = This file no longer exists.
render-error-forbidden = You do not have access to this file.
render-error-http = The server answered { $status }.
render-error-network = The file could not be downloaded. Check the connection and try again.

## Clipboard

render-copy-unavailable = Clipboard access is unavailable
render-copy-failed = Could not copy text
render-copy-failed-hint = Allow clipboard access and try again.

## Toolbar

render-toolbar-files = File controls
render-zoom = Zoom
render-zoom-in = Zoom in
render-zoom-out = Zoom out
# $percent is a percentage such as "125%".
render-zoom-level = Zoom, { $percent }
render-page = Page
render-page-number = Page number, 1 to { $count }

## Kind labels (shown under the file name)

render-kind-pdf = PDF document
render-kind-csv = CSV table
render-kind-tsv = TSV table
render-kind-docx = Word document
render-kind-image = Image
render-kind-image-ext = { $ext } image
render-kind-svg = SVG image
render-kind-audio = Audio
render-kind-audio-ext = { $ext } audio
render-kind-video = Video
render-kind-video-ext = { $ext } video
render-kind-html = HTML page
render-kind-archive = Archive
render-kind-archive-zip = ZIP archive
render-kind-archive-ext = { $ext } archive
render-kind-binary = Binary file
render-kind-binary-ext = { $ext } file
render-office-doc = Word 97-2003 document
render-office-xls = Excel 97-2003 workbook
render-office-xlsx = Excel workbook
render-office-ppt = PowerPoint 97-2003 presentation
render-office-pptx = PowerPoint presentation
render-office-odt = OpenDocument text
render-office-ods = OpenDocument spreadsheet

## Shared

render-copy = Copy
render-copied = Copied
render-copy-contents = Copy contents
render-wrap-on = Wrap long lines
render-wrap-off = Turn off line wrap
render-contents = Contents
# $name is a file name.
render-contents-of = Contents of { $name }
render-source-of = Source of { $name }
render-view-preview = Preview
render-view-source = Source
render-fit = Fit
render-fit-width = Fit width
render-line-status =
    { $count ->
        [one] { $count } line · { $label }
       *[other] { $count } lines · { $label }
    }
# $count is the number of characters cut from a long line.
render-code-more-characters =
    { $count ->
        [one] { $count } more character
       *[other] { $count } more characters
    }

## Archives and unknown files

render-binary-hex-label = First bytes in hexadecimal
render-binary-name = Name
render-binary-size = Size
render-binary-archive-label = Archive contents
render-binary-archive-hint = Download the archive to open its files.
render-binary-no-preview = There is no preview for this kind of file.
render-binary-file-count =
    { $count ->
        [one] { $count } file
       *[other] { $count } files
    }
render-binary-bytes-label = First bytes
render-binary-bytes =
    { $count ->
        [one] First { $count } byte
       *[other] First { $count } bytes
    }

## Audio and video

render-media-unplayable-title = This browser cannot play this file
render-media-unplayable-body = { $name } uses a format or codec this browser does not support. Download it to play it in another app.

## HTML

render-html-status-title = { $title } · HTML page
render-html-scripts = Run scripts
render-html-scripts-note = Scripts run isolated from this app, with no network access.
render-html-view = HTML view
render-html-options = Page options

## Markdown

# $minutes is the estimated reading time.
render-markdown-status =
    { $words ->
        [one] { $words } word · { $minutes } min read
       *[other] { $words } words · { $minutes } min read
    }
render-markdown-view = Markdown view
render-markdown-document = Document

## Images

# $width and $height are pixel sizes. $label is a kind label.
render-image-status = { $width } × { $height } px · { $label }
render-image-fit = Fit to view
render-image-actual = Actual size

## JSON

render-json-view = JSON view
render-json-view-tree = Tree
render-json-view-raw = Raw
render-json-copy-value = Copy value
render-json-copy = Copy JSON
render-json-expand = Expand all
render-json-collapse = Collapse all
render-json-as-text = Showing the text as it is.
render-json-unparsed = This is not valid JSON: it could not be parsed.
# $reason is an error from the JSON parser, in English.
render-json-invalid = This is not valid JSON: { $reason }.
render-json-invalid-line = This is not valid JSON: { $reason } near line { $line }.
render-json-line-invalid = Line { $line } is not valid JSON: { $reason }
render-json-items =
    { $count ->
        [one] [ { $count } item ]
       *[other] [ { $count } items ]
    }
render-json-keys =
    { $count ->
        [one] {"{"} { $count } key {"}"}
       *[other] {"{"} { $count } keys {"}"}
    }
render-json-status-records =
    { $count ->
        [one] { $count } record · JSON Lines
       *[other] { $count } records · JSON Lines
    }
render-json-status-values =
    { $count ->
        [one] { $count } value · JSON
       *[other] { $count } values · JSON
    }

## Word documents

render-docx-invalid = This file is not a valid Word document, or it is damaged.
render-docx-controls = Document controls
render-docx-status =
    { $count ->
        [one] { $count } page · Word document
       *[other] { $count } pages · Word document
    }

## PDF

render-pdf-invalid = This file is not a valid PDF, or it is damaged.
render-pdf-controls = PDF controls
render-pdf-status =
    { $count ->
        [one] { $count } page · PDF document
       *[other] { $count } pages · PDF document
    }
render-pdf-zoom-auto = Auto
render-pdf-zoom-width = Width
render-pdf-zoom-page = Page
render-pdf-zoom-actual = 100%
render-pdf-automatic = Automatic
render-pdf-fit-page = Fit page
render-pdf-show-pages = Show pages
render-pdf-hide-pages = Hide pages
render-pdf-pages = Pages
render-pdf-page-n = Page { $number }
render-pdf-find = Find in document
render-pdf-searching = Searching
render-pdf-no-results = No results
render-pdf-match = { $current } of { $total }
render-pdf-previous = Previous match
render-pdf-next = Next match
render-pdf-close-find = Close find
render-pdf-protected = This PDF is protected
render-pdf-password-prompt = Enter the document's password to open it.
render-pdf-password-wrong = That password is not right. Try again.
render-pdf-password = Password
render-pdf-open = Open

## Tables (CSV and TSV)

render-sheet-unreadable = The table could not be read.
render-sheet-controls = Table controls
render-sheet-options = Table options
render-sheet-loading =
    { $count ->
        [one] Loading { $count } row
       *[other] Loading { $count } rows
    }
# $rows and $columns are counts. $shown is the number of rows left after a filter.
render-sheet-status =
    { $rows ->
        [one] { $rows } row
       *[other] { $rows } rows
    } · { $columns ->
        [one] { $columns } column
       *[other] { $columns } columns
    }
render-sheet-status-filtered =
    { $rows ->
        [one] { $shown } of { $rows } row
       *[other] { $shown } of { $rows } rows
    } · { $columns ->
        [one] { $columns } column
       *[other] { $columns } columns
    }
# $number is the 1-based column position, used when a header cell is empty.
render-sheet-column = Column { $number }
render-sheet-row = Row
render-sheet-copy-cell = Copy cell
render-sheet-copy-row = Copy row
render-sheet-copy-column = Copy column
render-sheet-header-row = First row is the header
render-sheet-reset-widths = Reset column widths
render-sheet-truncated =
    { $count ->
        [one] Showing the first { $count } row. Download the file to see the rest.
       *[other] Showing the first { $count } rows. Download the file to see the rest.
    }
# $filter is text typed by the person.
render-sheet-no-match = No rows contain "{ $filter }".
render-sheet-no-data = This table has a header row and no data.
render-sheet-filter = Filter rows
render-sheet-filter-loading = Loading rows
render-sheet-filter-clear = Clear filter
render-sheet-sort-asc = Sort ascending
render-sheet-sort-desc = Sort descending
render-sheet-sort-clear = Clear sort
render-sheet-sort-wait = Sorting is available when the table finishes loading
render-sheet-select-column = Select column
render-sheet-fit-contents = Fit width to contents
render-sheet-column-options = Column options for { $name }
