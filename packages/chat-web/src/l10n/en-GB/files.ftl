# Files destination (components/files). File names, folder names, chat titles and search text are data.
# "Files" here is the page name. $name is a file or folder name. $count is a number of items.
# $size is a file size already formatted for the locale. $time is a time of day from Intl.DateTimeFormat.

## Page, sections and sidebar

files-title = Files
# $name is a folder name.
files-title-folder = { $name } - Files
files-nav-recent = Recent
files-nav-uploads = Uploads
files-nav-images = Images
files-nav-all = All files
files-nav-folders = All folders
files-tab-recent = Recent
files-tab-folders = Folders
files-tab-uploads = Uploads
files-tab-images = Images
files-tab-all = All files
files-root-files = Files
files-root-chats = Chats
files-root-projects = Projects
files-root-uploads = Uploads
files-chat-untitled = Untitled chat
files-section = Section
# $name is the name of the current section.
files-section-current = Section: { $name }
files-sections = File sections
files-search-title = Search
files-location-folder = Folder
files-trail-label = Folder path
files-trail-folders = Folders
files-trail-more =
    { $count ->
        [one] Show { $count } more folder
       *[other] Show { $count } more folders
    }

## Search

files-search = Search files
files-search-clear = Clear search

## Time

files-when-now = Just now
files-when-minutes = { $count } min ago
files-when-today = Today { $time }
files-when-yesterday = Yesterday { $time }

## Table columns

files-column-name = Name
files-column-location = Location
files-column-size = Size
files-column-modified = Modified

## Options menu

files-options-view = View
files-options-view-options = View options
files-options-sort-filter = Sort and filter
files-options-sort = Sort by
files-options-type = File type
files-options-source = Source
files-sort-recent = Recent
files-sort-name = Name
files-sort-size = Size
files-view-grid = Grid view
files-view-list = List view
files-view-tree = Tree view
files-view-images-cards = Images show as cards
files-filter-images = Images
files-filter-documents = Documents
files-filter-code = Code
files-filter-sheets = Spreadsheets
files-filter-pdfs = PDFs
files-source-uploaded = Uploaded
files-source-generated = Generated
files-filters-clear = Clear filters

## Uploads

files-upload = Upload
files-upload-files = Upload files
files-upload-photos = Upload photos and videos
files-upload-choose = Choose files
files-upload-media = Photos and videos
files-upload-camera = Take a photo
files-upload-failed = Upload failed
files-uploading-label = Uploads in progress
files-uploading = Uploading · { $size }
files-upload-dismiss = Dismiss { $name }
files-drop-title = Drop files to upload
files-drop-description = They are added to your uploads.
files-uploaded =
    { $count ->
        [one] File uploaded
       *[other] { $count } files uploaded
    }
files-deleted =
    { $count ->
        [one] File deleted
       *[other] { $count } files deleted
    }
files-undo-upload-failed = Could not undo the upload
files-delete-failed =
    { $count ->
        [one] Could not delete the file
       *[other] Could not delete the files
    }
files-delete-blocked = Only uploads can be deleted here
files-delete-blocked-hint = Files the assistant made stay in their chat or project folder.
files-error-account-changed = The account changed before this action completed.

## Item menus and actions

files-actions-open = Open actions menu for { $name }
files-select = Select { $name }
files-preview-label = Preview of { $name }
files-action-open-chat = Open chat
files-action-open-tab = Open in new tab
files-action-download = Download
files-menu-open = Open
files-menu-collapse = Collapse
files-menu-expand = Expand
files-menu-open-cards = Open as cards
files-menu-go-to-chat = Go to chat
files-menu-reveal-chat = Reveal in chat
files-menu-show-folder = Show in folder
files-menu-copy-path = Copy path
files-menu-copy-link = Copy link
files-menu-select = Select
files-menu-select-all = Select all
files-menu-refresh = Refresh
files-menu-delete = Delete
files-menu-this-folder = This folder
files-menu-items =
    { $count ->
        [one] { $count } item
       *[other] { $count } items
    }
files-bulk-download =
    { $count ->
        [one] Download { $count } file
       *[other] Download { $count } files
    }
files-bulk-copy-paths =
    { $count ->
        [one] Copy { $count } path
       *[other] Copy { $count } paths
    }
files-bulk-delete =
    { $count ->
        [one] Delete { $count } upload
       *[other] Delete { $count } uploads
    }
files-path-copied = Path copied
files-paths-copied =
    { $count ->
        [one] Path copied
       *[other] Paths copied
    }
files-link-copied = Link copied
files-path-copy-failed = Could not copy the path
files-copy-failed = Could not copy to the clipboard

## Selection

files-selection-clear = Clear selection
files-selected =
    { $count ->
        [one] { $count } selected
       *[other] { $count } selected
    }
files-selected-items =
    { $count ->
        [one] { $count } item selected
       *[other] { $count } items selected
    }
files-download-selected = Download selected
files-delete-selected = Delete selected

## Tree

files-tree-label = Workspace files
files-tree-loading = Loading
files-tree-load-failed = Could not load this folder.
files-tree-retry = Try again
files-tree-empty-chat = No files in this chat
files-tree-empty-folder = Empty folder

## Empty and error states

files-empty-chat-title = No files in this chat yet
files-empty-chat-description = Files the assistant saves in this chat show up here.
files-empty-project-title = No files in this project yet
files-empty-project-description = Files the assistant saves in this project's chats show up here.
files-empty-folders-title = No folders yet
files-empty-folders-description = Each chat and project gets a folder when the assistant saves a file.
files-empty-start-chat = Start a chat
files-empty-folder-title = This folder is empty
files-empty-folder-description = Files saved here show up in this folder.
files-empty-images-title = No images yet
files-empty-images-description = Images you upload or the assistant creates show up here.
files-empty-uploads-title = No uploads yet
files-empty-uploads-description = Drop files anywhere on this page, or use Upload.
files-empty-all-title = No files yet
files-empty-all-description = Files you upload, and files the assistant makes in your chats and projects, show up here.
# $query is text typed by the person.
files-no-match-title = No files match “{ $query }”
files-no-match-description = Try fewer words, or clear the search.
files-no-filter-title = Nothing matches these filters
files-no-filter-description = Turn off a filter to see more files.
files-invalid-title = This link is not valid
files-invalid-description = A Files link cannot contain empty folder names, “.” or “..”.
files-missing-title = This file or folder does not exist
files-missing-description = It may have been deleted or renamed, or the link is out of date.
files-go-all-folders = Go to All folders
files-forbidden-folder = You cannot open this folder
files-forbidden-list = You cannot open this list
files-load-folder-failed = Could not load this folder
files-load-failed = Could not load your files
