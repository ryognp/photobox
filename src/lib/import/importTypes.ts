export type ImportFileType = "csv" | "xlsx";

export type ColumnMapping = {
  imageUrlColumn: string | null;
  promptColumn: string | null;
  personColumn: string | null;
  sceneColumn: string | null;
  tagsColumn: string | null;
  ratingColumn: string | null;
  notesColumn: string | null;
};

export type ParsedRow = { __rowNumber: number; [key: string]: string | number };

export type ParseResult = {
  fileName: string;
  fileType: ImportFileType;
  sheetName: string;
  rowCount: number;
  columns: string[];
  preview: ParsedRow[];
  autoMapping: ColumnMapping;
  warnings: string[];
};

export type ImportStep = "upload" | "preview" | "mapping" | "run";
