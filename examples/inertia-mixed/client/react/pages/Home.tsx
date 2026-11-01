export default function Home({
  heading,
  framework,
}: {
  readonly heading: string;
  readonly framework: string;
}) {
  return (
    <>
      <h1>{heading}</h1>
      <p data-testid="framework">Rendered by {framework}</p>
    </>
  );
}
