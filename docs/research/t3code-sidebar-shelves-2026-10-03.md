# T3 Code: Position der Statusbereiche

Geprüft am 3. Oktober 2026 im offiziellen Repository `pingdotgg/t3code`, Commit `56914128c1ff9dcf6585c380b7b25845d6ca5f98`.

Die Bereiche stehen in einer gemeinsamen Flex-Spalte hinter den angehefteten und aktiven Threads. Ihre Reihenfolge ist Working, Snoozed, Settled. Working und Snoozed erscheinen bei vorhandenen Threads. [Listenaufbau](https://github.com/pingdotgg/t3code/blob/56914128c1ff9dcf6585c380b7b25845d6ca5f98/apps/web/src/components/Sidebar.tsx#L3584-L3621).

## Position und Scrollen

Der erste vorhandene Statusbereich bekommt `margin-top: auto`. Working hat immer `mt-auto`, Snoozed nur ohne Working und Settled nur ohne Working und Snoozed. Dadurch landet der gesamte Block bei kurzen Listen unten. Die übrigen Header folgen direkt aufeinander. [Headerposition](https://github.com/pingdotgg/t3code/blob/56914128c1ff9dcf6585c380b7b25845d6ca5f98/apps/web/src/components/Sidebar.tsx#L5131-L5186).

Das funktioniert durch `min-h-full` am Sidebar-Inhalt, `flex-1` an der Gruppe und `relative flex flex-col gap-px flex-1` an der Liste. Bei Überlauf scrollen aktive Threads und Statusbereiche gemeinsam. Der Such-/Projektkopf steht als `fixedHeader` außerhalb der ScrollArea. Die Statusbereiche verwenden weder `position: sticky` noch absolute Positionierung. [Inhalt und Liste](https://github.com/pingdotgg/t3code/blob/56914128c1ff9dcf6585c380b7b25845d6ca5f98/apps/web/src/components/Sidebar.tsx#L4671-L4677), [Flexgruppe und Liste](https://github.com/pingdotgg/t3code/blob/56914128c1ff9dcf6585c380b7b25845d6ca5f98/apps/web/src/components/Sidebar.tsx#L4833-L4934), [Scrollcontainer](https://github.com/pingdotgg/t3code/blob/56914128c1ff9dcf6585c380b7b25845d6ca5f98/apps/web/src/components/ui/sidebar.tsx#L585-L634).

## Header

Jeder Header ist 32 px hoch, mit 2 px äußerem Seitenabstand. Der Button hat 8 px horizontalen Innenabstand und 8 px Abstand zwischen Text, Trennlinie und Pfeil. Eine flexible 1-px-Linie füllt den Raum zwischen linksbündigem Namen und rechtem 12-px-Pfeil. Snoozed ist blau, Working und Settled verwenden gedämpfte Textfarben. [Headerrahmen](https://github.com/pingdotgg/t3code/blob/56914128c1ff9dcf6585c380b7b25845d6ca5f98/apps/web/src/components/Sidebar.tsx#L775-L810), [Headerkomponente](https://github.com/pingdotgg/t3code/blob/56914128c1ff9dcf6585c380b7b25845d6ca5f98/apps/web/src/components/ui/collapsible-section-header.tsx#L5-L49).

Die Kernaussage für Tau ist die Flex-Verteilung: oben aktive Inhalte, dazwischen freier Platz, unten ein zusammenhängender Statusblock. Bei langen Listen fällt der freie Platz weg und die gesamte Liste scrollt.

Tau hat bereits den gemeinsamen Scrollbereich. Die `.rail-shelves` liegen jedoch innerhalb der wachsenden `.rail-active-rows`, direkt nach den aktiven Zeilen. `flex: 1 0 auto` am Elterncontainer verteilt dessen freien Platz nicht automatisch zwischen diesen Kindern. In diesem Stand fehlt deshalb T3s `margin-top: auto` vor dem Statusblock. [Tau-Markup](../../kits/workspace/navigation.tsx#L1316), [Tau-Stile](../../kits/workspace/styles.css#L174).
