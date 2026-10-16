import type { MessageLanguage } from "../chatContext.js";

// What Twoody says in the chat about acting in a folder, in the ten
// languages of the app: written here from what was planned or done, never
// by the model (docs/agent-in-chat.md of twoody-desktop) — a 9B model says
// « C'est fait » without acting. The interface's words (the card, its
// buttons) are the apps' own; these are the messages of the conversation.

export type Language = MessageLanguage;
export const LANGUAGES: readonly Language[] = ["en", "fr", "de", "es", "it", "pt", "nl", "ja", "zh", "ko"];

export function quote(language: Language, text: string): string {
  switch (language) {
    case "fr": return `« ${text} »`;
    case "de": return `„${text}“`;
    case "es": case "it": return `«${text}»`;
    case "nl": case "ko": return `‘${text}’`;
    case "ja": return `「${text}」`;
    default: return `“${text}”`;
  }
}

type Vars = Record<string, string | number>;
type Table = Record<Language, string>;

const S = {
  // ── Proposals ──
  sortMonth: {
    en: "Here is what I propose in {folder}: move {n} {n|file|files} into {k} {k|folder|folders}, one per month.",
    fr: "Voici ce que je propose dans {folder} : ranger {n} {n|fichier|fichiers} dans {k} {k|dossier|dossiers}, un par mois.",
    de: "Mein Vorschlag für {folder}: {n} {n|Datei|Dateien} in {k} Ordner verschieben, einen pro Monat.",
    es: "Esto es lo que propongo en {folder}: mover {n} {n|archivo|archivos} a {k} {k|carpeta|carpetas}, una por mes.",
    it: "Ecco cosa propongo in {folder}: spostare {n} file in {k} {k|cartella|cartelle}, una per mese.",
    pt: "Eis o que proponho em {folder}: mover {n} {n|arquivo|arquivos} para {k} {k|pasta|pastas}, uma por mês.",
    nl: "Dit stel ik voor in {folder}: {n} {n|bestand|bestanden} verplaatsen naar {k} {k|map|mappen}, één per maand.",
    ja: "{folder} で次のことを提案します：{n} 個のファイルを月ごとの {k} 個のフォルダに移動します。",
    zh: "我建议在 {folder} 中：把 {n} 个文件移到 {k} 个按月份命名的文件夹里。",
    ko: "{folder}에서 다음을 제안합니다: 파일 {n}개를 월별 폴더 {k}개로 옮깁니다.",
  },
  sortYear: {
    en: "Here is what I propose in {folder}: move {n} {n|file|files} into {k} {k|folder|folders}, one per year.",
    fr: "Voici ce que je propose dans {folder} : ranger {n} {n|fichier|fichiers} dans {k} {k|dossier|dossiers}, un par année.",
    de: "Mein Vorschlag für {folder}: {n} {n|Datei|Dateien} in {k} Ordner verschieben, einen pro Jahr.",
    es: "Esto es lo que propongo en {folder}: mover {n} {n|archivo|archivos} a {k} {k|carpeta|carpetas}, una por año.",
    it: "Ecco cosa propongo in {folder}: spostare {n} file in {k} {k|cartella|cartelle}, una per anno.",
    pt: "Eis o que proponho em {folder}: mover {n} {n|arquivo|arquivos} para {k} {k|pasta|pastas}, uma por ano.",
    nl: "Dit stel ik voor in {folder}: {n} {n|bestand|bestanden} verplaatsen naar {k} {k|map|mappen}, één per jaar.",
    ja: "{folder} で次のことを提案します：{n} 個のファイルを年ごとの {k} 個のフォルダに移動します。",
    zh: "我建议在 {folder} 中：把 {n} 个文件移到 {k} 个按年份命名的文件夹里。",
    ko: "{folder}에서 다음을 제안합니다: 파일 {n}개를 연도별 폴더 {k}개로 옮깁니다.",
  },
  sortType: {
    en: "Here is what I propose in {folder}: move {n} {n|file|files} into {k} {k|folder|folders}, one per kind of file.",
    fr: "Voici ce que je propose dans {folder} : ranger {n} {n|fichier|fichiers} dans {k} {k|dossier|dossiers}, un par type de fichier.",
    de: "Mein Vorschlag für {folder}: {n} {n|Datei|Dateien} in {k} Ordner verschieben, einen pro Dateityp.",
    es: "Esto es lo que propongo en {folder}: mover {n} {n|archivo|archivos} a {k} {k|carpeta|carpetas}, una por tipo de archivo.",
    it: "Ecco cosa propongo in {folder}: spostare {n} file in {k} {k|cartella|cartelle}, una per tipo di file.",
    pt: "Eis o que proponho em {folder}: mover {n} {n|arquivo|arquivos} para {k} {k|pasta|pastas}, uma por tipo de arquivo.",
    nl: "Dit stel ik voor in {folder}: {n} {n|bestand|bestanden} verplaatsen naar {k} {k|map|mappen}, één per bestandstype.",
    ja: "{folder} で次のことを提案します：{n} 個のファイルを種類ごとの {k} 個のフォルダに移動します。",
    zh: "我建议在 {folder} 中：把 {n} 个文件按类型移到 {k} 个文件夹里。",
    ko: "{folder}에서 다음을 제안합니다: 파일 {n}개를 종류별 폴더 {k}개로 옮깁니다.",
  },
  rename: {
    en: "Here is what I propose in {folder}: rename {n} {n|file|files} so that each name starts with the file's date.",
    fr: "Voici ce que je propose dans {folder} : renommer {n} {n|fichier|fichiers} pour que chaque nom commence par la date du fichier.",
    de: "Mein Vorschlag für {folder}: {n} {n|Datei|Dateien} umbenennen, sodass jeder Name mit dem Datum der Datei beginnt.",
    es: "Esto es lo que propongo en {folder}: renombrar {n} {n|archivo|archivos} para que cada nombre empiece por su fecha.",
    it: "Ecco cosa propongo in {folder}: rinominare {n} file perché ogni nome inizi con la sua data.",
    pt: "Eis o que proponho em {folder}: renomear {n} {n|arquivo|arquivos} para que cada nome comece pela sua data.",
    nl: "Dit stel ik voor in {folder}: {n} {n|bestand|bestanden} hernoemen zodat elke naam met de datum begint.",
    ja: "{folder} で次のことを提案します：{n} 個のファイル名の先頭にその日付を付けます。",
    zh: "我建议在 {folder} 中：重命名 {n} 个文件，让每个文件名以其日期开头。",
    ko: "{folder}에서 다음을 제안합니다: 파일 {n}개의 이름이 날짜로 시작하도록 바꿉니다.",
  },
  draft: {
    en: "Here is what I propose in {folder}: write the Word document {name} from {n} {n|document|documents} of the folder.",
    fr: "Voici ce que je propose dans {folder} : rédiger le document Word {name} à partir de {n} {n|document|documents} du dossier.",
    de: "Mein Vorschlag für {folder}: das Word-Dokument {name} aus {n} {n|Dokument|Dokumenten} des Ordners erstellen.",
    es: "Esto es lo que propongo en {folder}: redactar el documento Word {name} a partir de {n} {n|documento|documentos} de la carpeta.",
    it: "Ecco cosa propongo in {folder}: scrivere il documento Word {name} a partire da {n} {n|documento|documenti} della cartella.",
    pt: "Eis o que proponho em {folder}: redigir o documento Word {name} a partir de {n} {n|documento|documentos} da pasta.",
    nl: "Dit stel ik voor in {folder}: het Word-document {name} schrijven op basis van {n} {n|document|documenten} uit de map.",
    ja: "{folder} で次のことを提案します：フォルダ内の {n} 個の書類から Word 文書 {name} を作成します。",
    zh: "我建议在 {folder} 中：根据文件夹里的 {n} 个文档写一份 Word 文档 {name}。",
    ko: "{folder}에서 다음을 제안합니다: 폴더의 문서 {n}개를 바탕으로 Word 문서 {name}을 작성합니다.",
  },
  table: {
    en: "Here is what I propose in {folder}: make the Excel table {name} from {n} {n|document|documents}.",
    fr: "Voici ce que je propose dans {folder} : faire le tableau Excel {name} à partir de {n} {n|document|documents}.",
    de: "Mein Vorschlag für {folder}: die Excel-Tabelle {name} aus {n} {n|Dokument|Dokumenten} erstellen.",
    es: "Esto es lo que propongo en {folder}: hacer la tabla Excel {name} a partir de {n} {n|documento|documentos}.",
    it: "Ecco cosa propongo in {folder}: fare la tabella Excel {name} a partire da {n} {n|documento|documenti}.",
    pt: "Eis o que proponho em {folder}: fazer a planilha Excel {name} a partir de {n} {n|documento|documentos}.",
    nl: "Dit stel ik voor in {folder}: de Excel-tabel {name} maken op basis van {n} {n|document|documenten}.",
    ja: "{folder} で次のことを提案します：{n} 個の書類から Excel の表 {name} を作成します。",
    zh: "我建议在 {folder} 中：根据 {n} 个文档制作 Excel 表格 {name}。",
    ko: "{folder}에서 다음을 제안합니다: 문서 {n}개로 Excel 표 {name}을 만듭니다.",
  },
  waits: {
    en: "Nothing is done until you agree: “Do it” below, or answer “yes”. I never delete a file and never replace a document.",
    fr: "Rien n'est fait tant que vous n'avez pas accepté : « Faire » ci-dessous, ou répondez « oui ». Je ne supprime aucun fichier et ne remplace aucun document.",
    de: "Nichts geschieht, bevor Sie zustimmen: „Ausführen“ unten, oder antworten Sie „ja“. Ich lösche keine Datei und ersetze kein Dokument.",
    es: "No se hace nada hasta que aceptes: «Hacerlo» abajo, o responde «sí». Nunca borro un archivo ni reemplazo un documento.",
    it: "Non faccio nulla finché non accetti: «Fallo» qui sotto, oppure rispondi «sì». Non elimino mai un file e non sostituisco mai un documento.",
    pt: "Nada é feito até você aceitar: “Fazer” abaixo, ou responda “sim”. Nunca apago um arquivo nem substituo um documento.",
    nl: "Er gebeurt niets tot u akkoord gaat: ‘Uitvoeren’ hieronder, of antwoord ‘ja’. Ik verwijder nooit een bestand en vervang nooit een document.",
    ja: "同意いただくまで何も行いません：下の「実行」を押すか、「はい」と答えてください。ファイルを削除したり、書類を上書きしたりすることはありません。",
    zh: "在你同意之前不会做任何事：点下面的“执行”，或回答“好”。我从不删除文件，也从不替换文档。",
    ko: "동의하시기 전에는 아무것도 하지 않습니다: 아래 ‘실행’을 누르거나 ‘네’라고 답해 주세요. 파일을 삭제하거나 문서를 덮어쓰지 않습니다.",
  },
  more: {
    en: "(the first {n}; the others stay where they are)",
    fr: "(les {n} premiers ; les autres restent où ils sont)",
    de: "(die ersten {n}; die anderen bleiben, wo sie sind)",
    es: "(los {n} primeros; los demás se quedan donde están)",
    it: "(i primi {n}; gli altri restano dove sono)",
    pt: "(os {n} primeiros; os outros ficam onde estão)",
    nl: "(de eerste {n}; de rest blijft waar die is)",
    ja: "（最初の {n} 個。残りはそのままです）",
    zh: "（前 {n} 个；其余的保持不动）",
    ko: "(처음 {n}개만, 나머지는 그대로 둡니다)",
  },
  // ── Not proposed ──
  delete: {
    en: "I never delete files. I can move them into a folder instead (for example “To sort”), and you can delete them yourself afterwards.",
    fr: "Je ne supprime jamais de fichier. Je peux en revanche les ranger dans un dossier (par exemple « À trier »), et vous pourrez les supprimer vous-même ensuite.",
    de: "Ich lösche nie Dateien. Ich kann sie aber in einen Ordner verschieben (zum Beispiel „Zu sortieren“), und Sie löschen sie danach selbst.",
    es: "Nunca borro archivos. Sí puedo moverlos a una carpeta (por ejemplo «Por ordenar»), y luego puedes borrarlos tú.",
    it: "Non elimino mai i file. Posso però spostarli in una cartella (per esempio «Da sistemare»), e poi puoi eliminarli tu.",
    pt: "Nunca apago arquivos. Posso movê-los para uma pasta (por exemplo “Para organizar”), e depois você mesmo os apaga.",
    nl: "Ik verwijder nooit bestanden. Ik kan ze wel naar een map verplaatsen (bijvoorbeeld ‘Te sorteren’), en daarna verwijdert u ze zelf.",
    ja: "ファイルを削除することはありません。代わりにフォルダ（例えば「整理用」）へ移動できますので、その後ご自身で削除してください。",
    zh: "我从不删除文件。不过我可以把它们移到一个文件夹（比如“待整理”），之后由你自己删除。",
    ko: "파일은 절대 삭제하지 않습니다. 대신 폴더(예: ‘정리할 것’)로 옮겨 드릴 수 있고, 삭제는 직접 하시면 됩니다.",
  },
  off: {
    en: "To have me do this, switch on “Work in your folders” in Capabilities on your computer. I will first show you what I plan to do.",
    fr: "Pour que je le fasse, activez « Agir dans vos dossiers » dans Capacités, sur votre ordinateur. Je vous montrerai d'abord ce que je compte faire.",
    de: "Damit ich das tue, schalten Sie „In Ihren Ordnern arbeiten“ unter Fähigkeiten auf Ihrem Computer ein. Ich zeige Ihnen zuerst, was ich vorhabe.",
    es: "Para que lo haga, activa «Trabajar en tus carpetas» en Capacidades, en tu ordenador. Primero te mostraré lo que pienso hacer.",
    it: "Perché lo faccia, attiva «Lavorare nelle tue cartelle» in Capacità, sul tuo computer. Prima ti mostrerò cosa intendo fare.",
    pt: "Para que eu faça isso, ative “Trabalhar nas suas pastas” em Capacidades, no seu computador. Primeiro mostro o que pretendo fazer.",
    nl: "Om dit te laten doen, zet u ‘Werken in uw mappen’ aan bij Mogelijkheden op uw computer. Ik laat u eerst zien wat ik van plan ben.",
    ja: "実行するには、コンピュータの「機能」で「フォルダで作業」をオンにしてください。まず何をするかをお見せします。",
    zh: "要让我这样做，请在电脑的“能力”中打开“在文件夹中操作”。我会先给你看我打算做什么。",
    ko: "이 작업을 하려면 컴퓨터의 ‘기능’에서 ‘폴더에서 작업’을 켜 주세요. 먼저 무엇을 할지 보여 드립니다.",
  },
  leftOut: {
    en: "“Work in your folders” is switched off for this message: switch it on in Tools, under the message, and ask again. I will first show you what I plan to do.",
    fr: "« Agir dans vos dossiers » est désactivé pour ce message : activez-le dans Outils, sous le message, et redemandez. Je vous montrerai d'abord ce que je compte faire.",
    de: "„In Ihren Ordnern arbeiten“ ist für diese Nachricht ausgeschaltet: Schalten Sie es unter Werkzeuge unter der Nachricht ein und fragen Sie erneut. Ich zeige Ihnen zuerst, was ich vorhabe.",
    es: "«Trabajar en tus carpetas» está desactivado para este mensaje: actívalo en Herramientas, bajo el mensaje, y vuelve a pedirlo. Primero te mostraré lo que pienso hacer.",
    it: "«Lavorare nelle tue cartelle» è disattivato per questo messaggio: attivalo in Strumenti, sotto il messaggio, e chiedi di nuovo. Prima ti mostrerò cosa intendo fare.",
    pt: "“Trabalhar nas suas pastas” está desativado para esta mensagem: ative em Ferramentas, abaixo da mensagem, e peça de novo. Primeiro mostro o que pretendo fazer.",
    nl: "‘Werken in uw mappen’ staat uit voor dit bericht: zet het aan bij Tools, onder het bericht, en vraag het opnieuw. Ik laat u eerst zien wat ik van plan ben.",
    ja: "このメッセージでは「フォルダで作業」がオフです。メッセージの下の「ツール」でオンにして、もう一度お尋ねください。まず何をするかをお見せします。",
    zh: "这条消息关闭了“在文件夹中操作”：请在消息下方的“工具”中打开它，然后再说一次。我会先给你看我打算做什么。",
    ko: "이 메시지에서는 ‘폴더에서 작업’이 꺼져 있습니다. 메시지 아래 ‘도구’에서 켜고 다시 요청해 주세요. 먼저 무엇을 할지 보여 드립니다.",
  },
  walled: {
    en: "“Work in your folders” is not available in a walled-off project: its documents stay as they are.",
    fr: "« Agir dans vos dossiers » n'est pas disponible dans un projet cloisonné : ses documents restent tels quels.",
    de: "„In Ihren Ordnern arbeiten“ ist in einem abgeschotteten Projekt nicht verfügbar: Seine Dokumente bleiben, wie sie sind.",
    es: "«Trabajar en tus carpetas» no está disponible en un proyecto aislado: sus documentos se quedan como están.",
    it: "«Lavorare nelle tue cartelle» non è disponibile in un progetto isolato: i suoi documenti restano come sono.",
    pt: "“Trabalhar nas suas pastas” não está disponível em um projeto isolado: os documentos dele ficam como estão.",
    nl: "‘Werken in uw mappen’ is niet beschikbaar in een afgeschermd project: de documenten blijven zoals ze zijn.",
    ja: "隔離されたプロジェクトでは「フォルダで作業」は使えません。その書類はそのままです。",
    zh: "在隔离的项目中不能使用“在文件夹中操作”：其中的文档保持原样。",
    ko: "격리된 프로젝트에서는 ‘폴더에서 작업’을 사용할 수 없습니다. 그 문서는 그대로 둡니다.",
  },
  paused: {
    en: "I am not touching your folders for the moment: a folder was moved or renamed outside Twoody, and until you find it again (Documents, in the Twoody app on this computer, says which), nothing new is read or changed in them.",
    fr: "Je ne touche pas à vos dossiers pour le moment : un dossier a été déplacé ou renommé hors de Twoody, et tant que vous ne l'avez pas retrouvé (Documents, dans l'app Twoody de cet ordinateur, dit lequel), rien de nouveau n'y est lu ni changé.",
    de: "Ich rühre Ihre Ordner im Moment nicht an: Ein Ordner wurde außerhalb von Twoody verschoben oder umbenannt, und bis Sie ihn wiederfinden (Dokumente in der Twoody-App auf diesem Computer sagt, welcher), wird darin nichts Neues gelesen oder geändert.",
    es: "No toco tus carpetas por ahora: una carpeta se movió o se renombró fuera de Twoody y, hasta que la vuelvas a encontrar (Documentos, en la app de Twoody de este ordenador, dice cuál), no se lee ni se cambia nada nuevo en ellas.",
    it: "Per ora non tocco le tue cartelle: una cartella è stata spostata o rinominata fuori da Twoody e, finché non la ritrovi (Documenti, nell'app Twoody di questo computer, dice quale), lì non si legge né si cambia nulla di nuovo.",
    pt: "Não mexo nas suas pastas por enquanto: uma pasta foi movida ou renomeada fora do Twoody e, até você encontrá-la de novo (Documentos, no app Twoody deste computador, diz qual), nada de novo é lido ou alterado nelas.",
    nl: "Ik raak uw mappen voorlopig niet aan: een map is buiten Twoody verplaatst of hernoemd, en tot u die terugvindt (Documenten, in de Twoody-app op deze computer, zegt welke) wordt er niets nieuws in gelezen of veranderd.",
    ja: "今はフォルダに手を付けません。Twoody の外でフォルダが移動または名前変更されました。それを見つけ直すまで（このコンピュータの Twoody アプリの「文書」にどれかが表示されます）、新しいものは読み込みも変更もしません。",
    zh: "我暂时不动你的文件夹：有一个文件夹在 Twoody 之外被移动或改名了，在你重新找到它之前（这台电脑上 Twoody 应用的“文档”会说是哪一个），不会读取或更改其中任何新内容。",
    ko: "지금은 폴더를 건드리지 않습니다. Twoody 밖에서 폴더 하나가 이동되거나 이름이 바뀌었고, 그 폴더를 다시 찾을 때까지(이 컴퓨터의 Twoody 앱 ‘문서’에 어느 폴더인지 나옵니다) 새로운 것은 읽거나 바꾸지 않습니다.",
  },
  notPerson: {
    en: "Only the person whose computer this is can have Twoody act in its folders, from its app or from their own devices.",
    fr: "Seule la personne à qui appartient cet ordinateur peut demander à Twoody d'agir dans ses dossiers, depuis son app ou ses propres appareils.",
    de: "Nur die Person, der dieser Computer gehört, kann Twoody in seinen Ordnern handeln lassen, über die App oder eigene Geräte.",
    es: "Solo la persona a quien pertenece este ordenador puede pedir a Twoody que actúe en sus carpetas, desde su app o sus propios dispositivos.",
    it: "Solo la persona a cui appartiene questo computer può chiedere a Twoody di agire nelle sue cartelle, dalla sua app o dai propri dispositivi.",
    pt: "Só a pessoa dona deste computador pode pedir ao Twoody que aja nas pastas dele, pelo app ou pelos próprios dispositivos.",
    nl: "Alleen de persoon van wie deze computer is, kan Twoody in de mappen laten handelen, via de app of de eigen apparaten.",
    ja: "このコンピュータの持ち主だけが、そのアプリまたは本人のデバイスから Twoody にフォルダでの作業を頼めます。",
    zh: "只有这台电脑的主人可以通过其应用或自己的设备让 Twoody 在其文件夹中操作。",
    ko: "이 컴퓨터의 주인만 앱이나 본인 기기에서 Twoody에게 폴더 작업을 요청할 수 있습니다.",
  },
  noFolders: {
    en: "No folder has been added to Documents yet: add the one I should work in, then ask again.",
    fr: "Aucun dossier n'est encore ajouté dans Documents : ajoutez celui où je dois agir, puis redemandez.",
    de: "Unter Dokumente ist noch kein Ordner hinzugefügt: Fügen Sie den hinzu, in dem ich arbeiten soll, und fragen Sie erneut.",
    es: "Aún no hay ninguna carpeta en Documentos: añade aquella en la que debo actuar y vuelve a pedirlo.",
    it: "Non c'è ancora nessuna cartella in Documenti: aggiungi quella in cui devo agire, poi chiedi di nuovo.",
    pt: "Ainda não há nenhuma pasta em Documentos: adicione aquela em que devo agir e peça de novo.",
    nl: "Er is nog geen map toegevoegd aan Documenten: voeg de map toe waarin ik moet werken en vraag het opnieuw.",
    ja: "「文書」にフォルダがまだ追加されていません。作業するフォルダを追加してから、もう一度お尋ねください。",
    zh: "“文档”中还没有添加任何文件夹：请添加我要操作的文件夹，然后再说一次。",
    ko: "‘문서’에 아직 폴더가 없습니다. 작업할 폴더를 추가한 뒤 다시 요청해 주세요.",
  },
  notFound: {
    en: "I can't find a folder {word} among your folders ({roots}). Tell me which one, for example: “sort Documents/Invoices by month”.",
    fr: "Je ne trouve pas de dossier {word} dans vos dossiers ({roots}). Dites-moi lequel, par exemple : « range Documents/Factures par mois ».",
    de: "Ich finde keinen Ordner {word} in Ihren Ordnern ({roots}). Sagen Sie mir, welchen, zum Beispiel: „Sortiere Dokumente/Rechnungen nach Monat“.",
    es: "No encuentro ninguna carpeta {word} entre tus carpetas ({roots}). Dime cuál, por ejemplo: «ordena Documentos/Facturas por mes».",
    it: "Non trovo una cartella {word} tra le tue cartelle ({roots}). Dimmi quale, per esempio: «ordina Documenti/Fatture per mese».",
    pt: "Não encontro nenhuma pasta {word} nas suas pastas ({roots}). Diga qual, por exemplo: “organize Documentos/Faturas por mês”.",
    nl: "Ik vind geen map {word} in uw mappen ({roots}). Zeg me welke, bijvoorbeeld: ‘sorteer Documenten/Facturen per maand’.",
    ja: "あなたのフォルダ（{roots}）に {word} というフォルダが見つかりません。例えば「書類/請求書 を月ごとに整理して」のように、どのフォルダか教えてください。",
    zh: "在你的文件夹（{roots}）中找不到 {word} 文件夹。请告诉我是哪个，例如：“把 文档/发票 按月整理”。",
    ko: "폴더({roots})에서 {word} 폴더를 찾을 수 없습니다. 예: ‘문서/청구서를 월별로 정리해 줘’처럼 어느 폴더인지 알려 주세요.",
  },
  whichFolder: {
    en: "In which folder? Your folders: {roots}. For example: “sort Documents/Invoices by month”.",
    fr: "Dans quel dossier ? Vos dossiers : {roots}. Par exemple : « range Documents/Factures par mois ».",
    de: "In welchem Ordner? Ihre Ordner: {roots}. Zum Beispiel: „Sortiere Dokumente/Rechnungen nach Monat“.",
    es: "¿En qué carpeta? Tus carpetas: {roots}. Por ejemplo: «ordena Documentos/Facturas por mes».",
    it: "In quale cartella? Le tue cartelle: {roots}. Per esempio: «ordina Documenti/Fatture per mese».",
    pt: "Em qual pasta? Suas pastas: {roots}. Por exemplo: “organize Documentos/Faturas por mês”.",
    nl: "In welke map? Uw mappen: {roots}. Bijvoorbeeld: ‘sorteer Documenten/Facturen per maand’.",
    ja: "どのフォルダですか？あなたのフォルダ：{roots}。例えば「書類/請求書 を月ごとに整理して」。",
    zh: "在哪个文件夹？你的文件夹：{roots}。例如：“把 文档/发票 按月整理”。",
    ko: "어느 폴더인가요? 폴더: {roots}. 예: ‘문서/청구서를 월별로 정리해 줘’.",
  },
  alreadySorted: {
    en: "The files of {folder} are already sorted: nothing to move.",
    fr: "Les fichiers de {folder} sont déjà rangés : rien à déplacer.",
    de: "Die Dateien in {folder} sind bereits sortiert: Nichts zu verschieben.",
    es: "Los archivos de {folder} ya están ordenados: nada que mover.",
    it: "I file di {folder} sono già ordinati: niente da spostare.",
    pt: "Os arquivos de {folder} já estão organizados: nada a mover.",
    nl: "De bestanden in {folder} zijn al gesorteerd: niets te verplaatsen.",
    ja: "{folder} のファイルはすでに整理されています。移動するものはありません。",
    zh: "{folder} 里的文件已经整理好了：没有要移动的。",
    ko: "{folder}의 파일은 이미 정리되어 있습니다. 옮길 것이 없습니다.",
  },
  alreadyDated: {
    en: "The files of {folder} already start with their date: nothing to rename.",
    fr: "Les fichiers de {folder} commencent déjà par leur date : rien à renommer.",
    de: "Die Dateien in {folder} beginnen bereits mit ihrem Datum: Nichts umzubenennen.",
    es: "Los archivos de {folder} ya empiezan por su fecha: nada que renombrar.",
    it: "I file di {folder} iniziano già con la loro data: niente da rinominare.",
    pt: "Os arquivos de {folder} já começam pela data: nada a renomear.",
    nl: "De bestanden in {folder} beginnen al met hun datum: niets te hernoemen.",
    ja: "{folder} のファイル名はすでに日付で始まっています。変更するものはありません。",
    zh: "{folder} 里的文件名已经以日期开头了：没有要重命名的。",
    ko: "{folder}의 파일 이름은 이미 날짜로 시작합니다. 바꿀 것이 없습니다.",
  },
  noDocuments: {
    en: "I can't find any document I can read in {folder}.",
    fr: "Je ne trouve aucun document que je sache lire dans {folder}.",
    de: "Ich finde in {folder} kein Dokument, das ich lesen kann.",
    es: "No encuentro ningún documento que pueda leer en {folder}.",
    it: "Non trovo nessun documento che io sappia leggere in {folder}.",
    pt: "Não encontro nenhum documento que eu consiga ler em {folder}.",
    nl: "Ik vind in {folder} geen document dat ik kan lezen.",
    ja: "{folder} に読める書類が見つかりません。",
    zh: "在 {folder} 中找不到我能读取的文档。",
    ko: "{folder}에서 읽을 수 있는 문서를 찾을 수 없습니다.",
  },
  declined: {
    en: "All right, I have done nothing.",
    fr: "D'accord, je n'ai rien fait.",
    de: "In Ordnung, ich habe nichts getan.",
    es: "De acuerdo, no he hecho nada.",
    it: "D'accordo, non ho fatto nulla.",
    pt: "Tudo bem, não fiz nada.",
    nl: "Goed, ik heb niets gedaan.",
    ja: "承知しました。何も行っていません。",
    zh: "好的，我什么都没做。",
    ko: "알겠습니다. 아무것도 하지 않았습니다.",
  },
  // ── Done ──
  sorted: {
    en: "Done: {n} {n|file|files} moved into {k} {k|folder|folders} of {folder}.",
    fr: "C'est fait : {n} {n|fichier rangé|fichiers rangés} dans {k} {k|dossier|dossiers} de {folder}.",
    de: "Erledigt: {n} {n|Datei|Dateien} in {k} Ordner von {folder} verschoben.",
    es: "Hecho: {n} {n|archivo movido|archivos movidos} a {k} {k|carpeta|carpetas} de {folder}.",
    it: "Fatto: {n} file {n|spostato|spostati} in {k} {k|cartella|cartelle} di {folder}.",
    pt: "Feito: {n} {n|arquivo movido|arquivos movidos} para {k} {k|pasta|pastas} de {folder}.",
    nl: "Klaar: {n} {n|bestand|bestanden} verplaatst naar {k} {k|map|mappen} in {folder}.",
    ja: "完了しました：{n} 個のファイルを {folder} 内の {k} 個のフォルダに移動しました。",
    zh: "完成：已把 {n} 个文件移到 {folder} 中的 {k} 个文件夹。",
    ko: "완료: 파일 {n}개를 {folder}의 폴더 {k}개로 옮겼습니다.",
  },
  renamed: {
    en: "Done: {n} {n|file|files} of {folder} renamed with their date.",
    fr: "C'est fait : {n} {n|fichier|fichiers} de {folder} {n|renommé|renommés} avec leur date.",
    de: "Erledigt: {n} {n|Datei|Dateien} in {folder} mit ihrem Datum umbenannt.",
    es: "Hecho: {n} {n|archivo|archivos} de {folder} {n|renombrado|renombrados} con su fecha.",
    it: "Fatto: {n} file di {folder} {n|rinominato|rinominati} con la loro data.",
    pt: "Feito: {n} {n|arquivo|arquivos} de {folder} {n|renomeado|renomeados} com a data.",
    nl: "Klaar: {n} {n|bestand|bestanden} in {folder} hernoemd met hun datum.",
    ja: "完了しました：{folder} の {n} 個のファイル名に日付を付けました。",
    zh: "完成：已为 {folder} 中的 {n} 个文件名加上日期。",
    ko: "완료: {folder}의 파일 {n}개 이름에 날짜를 붙였습니다.",
  },
  created: {
    en: "Done: I created {name} in {folder}, from {n} {n|document|documents}.",
    fr: "C'est fait : j'ai créé {name} dans {folder}, à partir de {n} {n|document|documents}.",
    de: "Erledigt: Ich habe {name} in {folder} erstellt, aus {n} {n|Dokument|Dokumenten}.",
    es: "Hecho: he creado {name} en {folder}, a partir de {n} {n|documento|documentos}.",
    it: "Fatto: ho creato {name} in {folder}, a partire da {n} {n|documento|documenti}.",
    pt: "Feito: criei {name} em {folder}, a partir de {n} {n|documento|documentos}.",
    nl: "Klaar: ik heb {name} gemaakt in {folder}, op basis van {n} {n|document|documenten}.",
    ja: "完了しました：{n} 個の書類から {folder} に {name} を作成しました。",
    zh: "完成：我根据 {n} 个文档在 {folder} 中创建了 {name}。",
    ko: "완료: 문서 {n}개로 {folder}에 {name}을 만들었습니다.",
  },
  nothingLost: {
    en: "No file was deleted or replaced.",
    fr: "Aucun fichier n'a été supprimé ni remplacé.",
    de: "Keine Datei wurde gelöscht oder ersetzt.",
    es: "No se ha borrado ni reemplazado ningún archivo.",
    it: "Nessun file è stato eliminato o sostituito.",
    pt: "Nenhum arquivo foi apagado ou substituído.",
    nl: "Er is geen bestand verwijderd of vervangen.",
    ja: "ファイルの削除や上書きは一切していません。",
    zh: "没有删除或替换任何文件。",
    ko: "삭제되거나 덮어쓴 파일은 없습니다.",
  },
  stopped: {
    en: "I stopped after {done} of {total}: {name} could not be moved ({reason}). What was done stays done; nothing was deleted or replaced.",
    fr: "Je me suis arrêté après {done} sur {total} : {name} n'a pas pu être déplacé ({reason}). Ce qui a été fait le reste ; rien n'a été supprimé ni remplacé.",
    de: "Ich habe nach {done} von {total} aufgehört: {name} konnte nicht verschoben werden ({reason}). Was erledigt ist, bleibt; nichts wurde gelöscht oder ersetzt.",
    es: "Me detuve tras {done} de {total}: no se pudo mover {name} ({reason}). Lo hecho se queda así; no se ha borrado ni reemplazado nada.",
    it: "Mi sono fermato dopo {done} su {total}: non è stato possibile spostare {name} ({reason}). Ciò che è fatto resta; nulla è stato eliminato o sostituito.",
    pt: "Parei depois de {done} de {total}: não foi possível mover {name} ({reason}). O que foi feito continua feito; nada foi apagado ou substituído.",
    nl: "Ik ben gestopt na {done} van {total}: {name} kon niet worden verplaatst ({reason}). Wat gedaan is, blijft; niets is verwijderd of vervangen.",
    ja: "{total} 個中 {done} 個で中断しました：{name} を移動できませんでした（{reason}）。済んだ分はそのままで、削除や上書きはしていません。",
    zh: "处理了 {total} 个中的 {done} 个后停止：{name} 无法移动（{reason}）。已完成的保持不变；没有删除或替换任何内容。",
    ko: "{total}개 중 {done}개 후 중단했습니다: {name}을(를) 옮길 수 없었습니다({reason}). 완료된 것은 그대로이며 삭제하거나 덮어쓴 것은 없습니다.",
  },
  failed: {
    en: "I could not do it: {reason}. Nothing was changed.",
    fr: "Je n'ai pas pu le faire : {reason}. Rien n'a été modifié.",
    de: "Ich konnte es nicht tun: {reason}. Nichts wurde geändert.",
    es: "No he podido hacerlo: {reason}. No se ha cambiado nada.",
    it: "Non sono riuscito a farlo: {reason}. Non è stato cambiato nulla.",
    pt: "Não consegui fazer: {reason}. Nada foi alterado.",
    nl: "Ik kon het niet doen: {reason}. Er is niets veranderd.",
    ja: "実行できませんでした：{reason}。何も変更していません。",
    zh: "我没能完成：{reason}。没有做任何更改。",
    ko: "실행하지 못했습니다: {reason}. 아무것도 바꾸지 않았습니다.",
  },
  undone: {
    en: "I put {n} {n|file|files} back where they were.",
    fr: "J'ai remis {n} {n|fichier|fichiers} à leur place.",
    de: "Ich habe {n} {n|Datei|Dateien} an ihren Platz zurückgelegt.",
    es: "He devuelto {n} {n|archivo|archivos} a su sitio.",
    it: "Ho rimesso {n} file al loro posto.",
    pt: "Coloquei {n} {n|arquivo|arquivos} de volta no lugar.",
    nl: "Ik heb {n} {n|bestand|bestanden} teruggezet op hun plek.",
    ja: "{n} 個のファイルを元の場所に戻しました。",
    zh: "我把 {n} 个文件放回了原处。",
    ko: "파일 {n}개를 원래 위치로 되돌렸습니다.",
  },
  undoLeft: {
    en: "{m} could not be: moved or replaced since.",
    fr: "{m} {m|n'a pas pu l'être : déplacé ou remplacé depuis.|n'ont pas pu l'être : déplacés ou remplacés depuis.}",
    de: "{m} ging nicht: inzwischen verschoben oder ersetzt.",
    es: "{m} no se pudieron: movidos o reemplazados desde entonces.",
    it: "{m} non è stato possibile: spostati o sostituiti nel frattempo.",
    pt: "{m} não puderam: movidos ou substituídos desde então.",
    nl: "{m} lukte niet: intussen verplaatst of vervangen.",
    ja: "{m} 個は戻せませんでした（その後移動または置き換えられています）。",
    zh: "{m} 个无法放回：之后已被移动或替换。",
    ko: "{m}개는 되돌리지 못했습니다(그 사이 이동되거나 바뀌었습니다).",
  },
} satisfies Record<string, Table>;

export type Sentence = keyof typeof S;

/// Why something could not be done, said in the sentence above.
const REASONS = {
  capability_off: {
    en: "“Work in your folders” is switched off", fr: "« Agir dans vos dossiers » est désactivé", de: "„In Ihren Ordnern arbeiten“ ist ausgeschaltet", es: "«Trabajar en tus carpetas» está desactivado", it: "«Lavorare nelle tue cartelle» è disattivato",
    pt: "“Trabalhar nas suas pastas” está desativado", nl: "‘Werken in uw mappen’ staat uit", ja: "「フォルダで作業」がオフです", zh: "“在文件夹中操作”已关闭", ko: "‘폴더에서 작업’이 꺼져 있습니다",
  },
  folder_gone: {
    en: "the folder is no longer there", fr: "le dossier n'est plus là", de: "der Ordner ist nicht mehr da", es: "la carpeta ya no está", it: "la cartella non c'è più",
    pt: "a pasta não está mais lá", nl: "de map is er niet meer", ja: "フォルダが見つかりません", zh: "文件夹已不存在", ko: "폴더가 더 이상 없습니다",
  },
  not_granted: {
    en: "the folder is no longer in Documents", fr: "le dossier n'est plus dans Documents", de: "der Ordner ist nicht mehr unter Dokumente", es: "la carpeta ya no está en Documentos", it: "la cartella non è più in Documenti",
    pt: "a pasta não está mais em Documentos", nl: "de map staat niet meer in Documenten", ja: "フォルダが「文書」から外されています", zh: "文件夹已不在“文档”中", ko: "폴더가 더 이상 ‘문서’에 없습니다",
  },
  walled: {
    en: "the folder belongs to a walled-off project", fr: "le dossier appartient à un projet cloisonné", de: "der Ordner gehört zu einem abgeschotteten Projekt", es: "la carpeta pertenece a un proyecto aislado", it: "la cartella appartiene a un progetto isolato",
    pt: "a pasta pertence a um projeto isolado", nl: "de map hoort bij een afgeschermd project", ja: "フォルダが隔離されたプロジェクトのものです", zh: "该文件夹属于一个隔离的项目", ko: "폴더가 격리된 프로젝트에 속합니다",
  },
  paused: {
    en: "a folder was moved or renamed outside Twoody and must be found again first", fr: "un dossier a été déplacé ou renommé hors de Twoody et doit d'abord être retrouvé", de: "ein Ordner wurde außerhalb von Twoody verschoben oder umbenannt und muss zuerst wiedergefunden werden", es: "una carpeta se movió o se renombró fuera de Twoody y primero hay que volver a encontrarla", it: "una cartella è stata spostata o rinominata fuori da Twoody e va prima ritrovata",
    pt: "uma pasta foi movida ou renomeada fora do Twoody e precisa ser encontrada de novo primeiro", nl: "een map is buiten Twoody verplaatst of hernoemd en moet eerst worden teruggevonden", ja: "Twoody の外でフォルダが移動または名前変更されたため、先に見つけ直す必要があります", zh: "有一个文件夹在 Twoody 之外被移动或改名，需要先重新找到它", ko: "Twoody 밖에서 폴더가 이동되거나 이름이 바뀌어 먼저 다시 찾아야 합니다",
  },
  source_missing: {
    en: "the file is no longer there", fr: "le fichier n'est plus là", de: "die Datei ist nicht mehr da", es: "el archivo ya no está", it: "il file non c'è più",
    pt: "o arquivo não está mais lá", nl: "het bestand is er niet meer", ja: "ファイルが見つかりません", zh: "文件已不存在", ko: "파일이 더 이상 없습니다",
  },
  destination_exists: {
    en: "a file already has that name", fr: "un fichier porte déjà ce nom", de: "eine Datei hat bereits diesen Namen", es: "ya hay un archivo con ese nombre", it: "esiste già un file con quel nome",
    pt: "já existe um arquivo com esse nome", nl: "er bestaat al een bestand met die naam", ja: "同じ名前のファイルがすでにあります", zh: "已有同名文件", ko: "같은 이름의 파일이 이미 있습니다",
  },
  model_unavailable: {
    en: "no model of this computer is available", fr: "aucun modèle de cet ordinateur n'est disponible", de: "kein Modell dieses Computers ist verfügbar", es: "no hay ningún modelo de este ordenador disponible", it: "nessun modello di questo computer è disponibile",
    pt: "nenhum modelo deste computador está disponível", nl: "er is geen model van deze computer beschikbaar", ja: "このコンピュータのモデルが使えません", zh: "这台电脑上没有可用的模型", ko: "이 컴퓨터의 모델을 사용할 수 없습니다",
  },
  no_table: {
    en: "the model did not make a table", fr: "le modèle n'a pas fait de tableau", de: "das Modell hat keine Tabelle erstellt", es: "el modelo no hizo ninguna tabla", it: "il modello non ha fatto nessuna tabella",
    pt: "o modelo não fez uma tabela", nl: "het model heeft geen tabel gemaakt", ja: "モデルが表を作りませんでした", zh: "模型没有生成表格", ko: "모델이 표를 만들지 않았습니다",
  },
  empty: {
    en: "the model wrote nothing", fr: "le modèle n'a rien écrit", de: "das Modell hat nichts geschrieben", es: "el modelo no escribió nada", it: "il modello non ha scritto nulla",
    pt: "o modelo não escreveu nada", nl: "het model heeft niets geschreven", ja: "モデルが何も書きませんでした", zh: "模型什么都没写", ko: "모델이 아무것도 쓰지 않았습니다",
  },
  failed: {
    en: "an error occurred", fr: "une erreur est survenue", de: "ein Fehler ist aufgetreten", es: "se produjo un error", it: "si è verificato un errore",
    pt: "ocorreu um erro", nl: "er is een fout opgetreden", ja: "エラーが発生しました", zh: "发生了错误", ko: "오류가 발생했습니다",
  },
} satisfies Record<string, Table>;

export type Reason = keyof typeof REASONS;
export const REASON_CODES = Object.keys(REASONS) as Reason[];

export function reasonText(language: Language, reason: Reason): string {
  return REASONS[reason]?.[language] ?? REASONS.failed[language];
}

export function say(language: Language, sentence: Sentence, vars: Vars = {}): string {
  const table: Table = S[sentence];
  const text = table[language] ?? table.en;
  // « {n|fichier|fichiers} »: the form for one, or for several.
  return text
    .replace(/\{(\w+)\|([^|{}]*)\|([^|{}]*)\}/g, (whole, name: string, one: string, many: string) => (name in vars ? (Number(vars[name]) === 1 ? one : many) : whole))
    .replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/// The language of the person's message, else their app's, else English.
export function languageOf(detected: MessageLanguage | null, locale: string | null): Language {
  if (detected) return detected;
  const code = (locale ?? "").slice(0, 2).toLowerCase();
  return (LANGUAGES as readonly string[]).includes(code) ? (code as Language) : "en";
}

/// A list said in the language: « A, B et C ».
export function listed(language: Language, items: string[]): string {
  if (items.length <= 1) return items.join("");
  const and = { en: " and ", fr: " et ", de: " und ", es: " y ", it: " e ", pt: " e ", nl: " en ", ja: "、", zh: "、", ko: ", " }[language];
  const comma = language === "ja" || language === "zh" ? "、" : ", ";
  return `${items.slice(0, -1).join(comma)}${and}${items[items.length - 1]}`;
}
