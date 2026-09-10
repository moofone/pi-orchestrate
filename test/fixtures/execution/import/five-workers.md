# Search and notifications
Build search in src/search and notifications in src/notifications.
For search, launch five independent workers simultaneously: index, query, rank, cache, and UI.
Use agent specialist with model custom/model and fork context for all five workers.
Integrate search into one PR and notifications into a separate PR.
Notifications should progress independently while search runs.
