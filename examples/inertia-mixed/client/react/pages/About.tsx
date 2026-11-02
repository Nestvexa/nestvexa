export default function About({
  heading,
  framework,
}: {
  readonly heading: string;
  readonly framework: string;
}) {
  return (
    <>
      <h1>{heading}</h1>
      <p data-testid="framework">
        {framework} page reached without leaving the React root.
      </p>
    </>
  );
}
